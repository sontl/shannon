// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Production Claude agent execution with retry, git checkpoints, and audit logging

import { fs, path } from 'zx';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { isRetryableError, PentestError } from '../services/error-handling.js';
import { isSpendingCapBehavior } from '../utils/billing-detection.js';
import { Timer } from '../utils/metrics.js';
import { formatTimestamp } from '../utils/formatting.js';
import { AGENT_VALIDATORS, MCP_AGENT_MAPPING } from '../session-manager.js';
import { AuditSession } from '../audit/index.js';
import { createShannonHelperServer } from '../../mcp-server/dist/index.js';
import { createAppiumTools } from '../../mcp-server/dist/appium/tools.js';
import { AGENTS } from '../session-manager.js';
import type { AgentName } from '../types/index.js';

import { dispatchMessage } from './message-handlers.js';
import { detectExecutionContext, formatErrorOutput, formatCompletionMessage } from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createAuditLogger } from './audit-logger.js';
import { getActualModelName } from './router-utils.js';
import { resolveModel, type ModelTier } from './models.js';
import type { ActivityLogger } from '../types/activity-logger.js';

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

export interface ClaudePromptResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
}

interface StdioMcpServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

type McpServer = ReturnType<typeof createShannonHelperServer> | StdioMcpServer;

// Configures MCP servers for agent execution, with Docker-specific Chromium handling.
// When personaName is provided, the Playwright user-data-dir is namespaced under
// the workspace so cookies persist across agents of the same persona within the
// run, and stay isolated between personas.
async function buildMcpServers(
  sourceDir: string,
  agentName: string | null,
  logger: ActivityLogger,
  personaName: string | undefined
): Promise<Record<string, McpServer>> {
  // 1. Create the shannon-helper server (always present)
  const shannonHelperServer = createShannonHelperServer(sourceDir);

  const mcpServers: Record<string, McpServer> = {
    'shannon-helper': shannonHelperServer,
  };

  // 2. Look up the agent's MCP mapping (Playwright or Appium)
  if (agentName) {
    const promptTemplate = AGENTS[agentName as AgentName].promptTemplate;
    const mcpName = MCP_AGENT_MAPPING[promptTemplate as keyof typeof MCP_AGENT_MAPPING] || null;

    if (mcpName === 'api-only') {
      // 3a. API agents use only shannon-helper — no browser/device automation
      logger.info(`Assigned ${agentName} -> api-only (no MCP server, Bash+curl only)`);

    } else if (mcpName && mcpName.startsWith('appium-')) {
      // 3b. Configure Appium MCP for mobile agents (in-process, like shannon-helper)
      logger.info(`Assigned ${agentName} -> ${mcpName} (Appium)`);

      const appiumUrl = process.env.APPIUM_URL || 'http://localhost:4723';
      const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
      const appiumTools = createAppiumTools(appiumUrl);

      mcpServers[mcpName] = createSdkMcpServer({
        name: mcpName,
        version: '1.0.0',
        tools: appiumTools,
      });

    } else if (mcpName) {
      // 3b. Configure Playwright MCP for web agents
      logger.info(`Assigned ${agentName} -> ${mcpName}${personaName ? ` (persona: ${personaName})` : ''}`);

      // Keep Playwright runtime artifacts (browser profiles, traces) under a
      // single hidden subfolder so the workspace root stays clean — only
      // orchestrator output (session.json, workflow.log, agents/, prompts/,
      // deliverables/) should be visible there.
      const userDataDir = personaName
        ? path.join(sourceDir, '.runtime', 'browsers', personaName, mcpName)
        : `/tmp/${mcpName}`;
      await fs.mkdirp(userDataDir);

      // Clean Chromium singleton artifacts from a previous killed attempt.
      // When Temporal kills an activity mid-run (StartToClose / heartbeat
      // timeout), the Playwright MCP subprocess dies but Chromium may leave
      // behind SingletonLock/Cookie/Socket entries. The next spawn then sees
      // an "already running" profile and refuses to launch — the SDK reports
      // the MCP server as connected but every browser_* call fails, so the
      // agent silently falls back to curl. Remove these markers up-front.
      for (const marker of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        await fs.remove(path.join(userDataDir, marker)).catch(() => { /* best-effort */ });
      }

      const isDocker = process.env.SHANNON_DOCKER === 'true';

      // Per-action screenshots + DOM/network/console for replay. Trace ZIP
      // viewable with `npx playwright show-trace <file>`.
      const traceDir = path.join(sourceDir, '.runtime', 'traces', personaName || 'default');
      await fs.mkdirp(traceDir);

      const mcpArgs: string[] = [
        '@playwright/mcp@0.0.68',
        '--isolated',
        '--user-data-dir', userDataDir,
        '--save-trace',
        '--output-dir', traceDir,
      ];

      if (isDocker) {
        mcpArgs.push('--executable-path', '/usr/bin/chromium-browser');
        mcpArgs.push('--browser', 'chromium');
      }

      // NOTE: Explicit allowlist — the Playwright MCP subprocess must not inherit
      // secrets (API keys, AWS tokens) from the parent process.
      const MCP_ENV_ALLOWLIST = [
        'PATH', 'HOME', 'NODE_PATH', 'DISPLAY',
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
      ] as const;

      const envVars: Record<string, string> = {
        PLAYWRIGHT_HEADLESS: 'true',
        ...(isDocker && { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }),
      };

      for (const key of MCP_ENV_ALLOWLIST) {
        if (process.env[key]) {
          envVars[key] = process.env[key]!;
        }
      }

      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('XDG_') && value !== undefined) {
          envVars[key] = value;
        }
      }

      mcpServers[mcpName] = {
        type: 'stdio' as const,
        command: 'npx',
        args: mcpArgs,
        env: envVars,
      };
    }
  }

  // 4. Return configured servers
  return mcpServers;
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'claude-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack
      },
      context: {
        sourceDir,
        prompt: fullPrompt.slice(0, 200) + '...',
        retryable: isRetryableError(err)
      },
      duration
    };
    const logPath = path.join(sourceDir, 'error.log');
    await fs.appendFile(logPath, JSON.stringify(errorLog) + '\n');
  } catch {
    // Best-effort error log writing - don't propagate failures
  }
}

export async function validateAgentOutput(
  result: ClaudePromptResult,
  agentName: string | null,
  sourceDir: string,
  logger: ActivityLogger,
  personaName?: string
): Promise<boolean> {
  logger.info(`Validating ${agentName} agent output`);

  try {
    // Check if agent completed successfully
    if (!result.success || !result.result) {
      logger.error('Validation failed: Agent execution was unsuccessful');
      return false;
    }

    // Get validator function for this agent
    const validator = agentName ? AGENT_VALIDATORS[agentName as keyof typeof AGENT_VALIDATORS] : undefined;

    if (!validator) {
      logger.warn(`No validator found for agent "${agentName}" - assuming success`);
      logger.info('Validation passed: Unknown agent with successful result');
      return true;
    }

    logger.info(`Using validator for agent: ${agentName}`, { sourceDir, personaName });

    // Apply validation function
    const validationResult = await validator(sourceDir, logger, personaName);

    if (validationResult) {
      logger.info('Validation passed: Required files/structure present');
    } else {
      logger.error('Validation failed: Missing required deliverable files');
    }

    return validationResult;

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Validation failed with error: ${errMsg}`);
    return false;
  }
}

// Low-level SDK execution. Handles message streaming, progress, and audit logging.
// Exported for Temporal activities to call single-attempt execution.
export async function runClaudePrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Claude analysis',
  agentName: string | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium',
  personaName?: string,
  abortController?: AbortController
): Promise<ClaudePromptResult> {
  // 1. Initialize timing and prompt
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  // 2. Set up progress and audit infrastructure
  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);

  logger.info(`Running Claude Code: ${description}...`);

  // 3. Configure MCP servers
  const mcpServers = await buildMcpServers(sourceDir, agentName, logger, personaName);

  // 3b. Resolve the browser/device MCP server this agent expects. Used by
  // dispatchMessage to fail fast if SDK reports the server didn't connect,
  // and to count `mcp__<name>__*` tool calls so a silent fallback to
  // Bash/curl is caught after the run finishes.
  const expectedMcpServer = agentName
    ? (() => {
        const promptTemplate = AGENTS[agentName as AgentName].promptTemplate;
        const mapped = MCP_AGENT_MAPPING[promptTemplate as keyof typeof MCP_AGENT_MAPPING];
        return mapped && mapped !== 'api-only' ? mapped : undefined;
      })()
    : undefined;

  // 4. Build env vars to pass to SDK subprocesses
  const sdkEnv: Record<string, string> = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '64000',
  };
  const passthroughVars = [
    // PATH + shell basics — required so Bash tool can find curl, ls, cat, etc.
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_REGION',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ANTHROPIC_SMALL_MODEL',
    'ANTHROPIC_MEDIUM_MODEL',
    'ANTHROPIC_LARGE_MODEL',
  ];
  for (const name of passthroughVars) {
    if (process.env[name]) {
      sdkEnv[name] = process.env[name]!;
    }
  }

  // 5. Configure SDK options
  // Bridge Temporal cancellation: when the activity is cancelled (StartToClose
  // timeout, heartbeat timeout, workflow cancel), abort the SDK iterator so the
  // Node process stops making API calls. Without this, abandoned attempts keep
  // burning tokens until maxTurns (~10k) — see runAgentActivity in
  // src/temporal/activities.ts where the controller is wired to Context.
  const options = {
    model: resolveModel(modelTier),
    maxTurns: 10_000,
    cwd: sourceDir,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    mcpServers,
    env: sdkEnv,
    ...(abortController && { abortController }),
  };

  if (!execContext.useCleanOutput) {
    logger.info(`SDK Options: maxTurns=${options.maxTurns}, cwd=${sourceDir}, permissions=BYPASS`);
  }

  let turnCount = 0;
  let result: string | null = null;
  let apiErrorDetected = false;
  let totalCost = 0;

  progress.start();

  // Counter mutated by dispatchMessage on every matching tool_use.
  const mcpToolCallCounter = { count: 0 };

  try {
    // 6. Process the message stream
    const messageLoopResult = await processMessageStream(
      fullPrompt,
      options,
      {
        execContext, description, progress, auditLogger, logger,
        ...(expectedMcpServer && { expectedMcpServer, mcpToolCallCounter }),
      },
      timer
    );

    turnCount = messageLoopResult.turnCount;
    result = messageLoopResult.result;
    apiErrorDetected = messageLoopResult.apiErrorDetected;
    totalCost = messageLoopResult.cost;
    const model = messageLoopResult.model;

    // Soft signal: agent was wired to a browser/device MCP but never called it
    // once. The init guard already fails fast when the server fails to register;
    // a zero count here means the server reported "connected" but the agent
    // still drifted to Bash/curl — usually because Chromium can't actually
    // launch despite a successful stdio handshake. Log as error so the
    // workflow.log makes the regression obvious; the per-agent prompt is
    // expected to refuse to save when its mandatory tools are missing.
    if (expectedMcpServer && mcpToolCallCounter.count === 0) {
      logger.error(
        `Agent "${agentName}" never invoked any mcp__${expectedMcpServer}__* tool ` +
        `despite being assigned that server. Deliverable evidence quality will be degraded.`
      );
    }

    // === SPENDING CAP SAFEGUARD ===
    // 7. Defense-in-depth: Detect spending cap that slipped through detectApiError().
    // Uses consolidated billing detection from utils/billing-detection.ts
    if (isSpendingCapBehavior(turnCount, totalCost, result || '')) {
      throw new PentestError(
        `Spending cap likely reached (turns=${turnCount}, cost=$0): ${result?.slice(0, 100)}`,
        'billing',
        true // Retryable - Temporal will use 5-30 min backoff
      );
    }

    // 8. Finalize successful result
    const duration = timer.stop();

    if (apiErrorDetected) {
      logger.warn(`API Error detected in ${description} - will validate deliverables before failing`);
    }

    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost: totalCost,
      model,
      partialCost: totalCost,
      apiErrorDetected
    };

  } catch (error) {
    // 9. Handle errors — log, write error file, return failure
    const duration = timer.stop();

    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: totalCost,
      retryable: isRetryableError(err)
    };
  }
}


interface MessageLoopResult {
  turnCount: number;
  result: string | null;
  apiErrorDetected: boolean;
  cost: number;
  model?: string | undefined;
}

interface MessageLoopDeps {
  execContext: ReturnType<typeof detectExecutionContext>;
  description: string;
  progress: ReturnType<typeof createProgressManager>;
  auditLogger: ReturnType<typeof createAuditLogger>;
  logger: ActivityLogger;
}

async function processMessageStream(
  fullPrompt: string,
  options: NonNullable<Parameters<typeof query>[0]['options']>,
  deps: MessageLoopDeps,
  timer: Timer
): Promise<MessageLoopResult> {
  const { execContext, description, progress, auditLogger, logger } = deps;
  const HEARTBEAT_INTERVAL = 30000;

  let turnCount = 0;
  let result: string | null = null;
  let apiErrorDetected = false;
  let cost = 0;
  let model: string | undefined;
  let lastHeartbeat = Date.now();

  for await (const message of query({ prompt: fullPrompt, options })) {
    // Heartbeat logging when loader is disabled
    const now = Date.now();
    if (global.SHANNON_DISABLE_LOADER && now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      logger.info(`[${Math.floor((now - timer.startTime) / 1000)}s] ${description} running... (Turn ${turnCount})`);
      lastHeartbeat = now;
    }

    // Increment turn count for assistant messages
    if (message.type === 'assistant') {
      turnCount++;
    }

    const dispatchResult = await dispatchMessage(
      message as { type: string; subtype?: string },
      turnCount,
      { execContext, description, progress, auditLogger, logger }
    );

    if (dispatchResult.type === 'throw') {
      throw dispatchResult.error;
    }

    if (dispatchResult.type === 'complete') {
      result = dispatchResult.result;
      cost = dispatchResult.cost;
      break;
    }

    if (dispatchResult.type === 'continue') {
      if (dispatchResult.apiErrorDetected) {
        apiErrorDetected = true;
      }
      // Capture model from SystemInitMessage, but override with router model if applicable
      if (dispatchResult.model) {
        model = getActualModelName(dispatchResult.model);
      }
    }
  }

  return { turnCount, result, apiErrorDetected, cost, model };
}
