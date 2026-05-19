// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Agent Execution Service
 *
 * Handles the full agent lifecycle:
 * - Load config via ConfigLoaderService
 * - Load prompt template using AGENTS[agentName].promptTemplate
 * - Create git checkpoint
 * - Start audit logging
 * - Invoke Claude SDK via runClaudePrompt
 * - Spending cap check using isSpendingCapBehavior
 * - Handle failure (rollback, audit)
 * - Validate output using AGENTS[agentName].deliverableFilename
 * - Commit on success, log metrics
 *
 * No Temporal dependencies - pure domain logic.
 */

import path from 'path';

import type { ActivityLogger } from '../types/activity-logger.js';
import { Result, ok, err, isErr } from '../types/result.js';
import { ErrorCode, type PentestErrorType } from '../types/errors.js';
import { PentestError } from './error-handling.js';
import { isSpendingCapBehavior } from '../utils/billing-detection.js';
import { AGENTS } from '../session-manager.js';
import { loadPrompt } from './prompt-manager.js';
import {
  runClaudePrompt,
  validateAgentOutput,
  type ClaudePromptResult,
} from '../ai/claude-executor.js';
import {
  createGitCheckpoint,
  commitGitSuccess,
  rollbackGitWorkspace,
  getGitCommitHash,
} from './git-manager.js';
import { AuditSession } from '../audit/index.js';
import type { AgentEndResult } from '../types/audit.js';
import type { AgentName } from '../types/agents.js';
import type { ConfigLoaderService } from './config-loader.js';
import type { AgentMetrics } from '../types/metrics.js';
import { fileExists } from '../utils/file-io.js';

// Agents that fan out per-persona AND write a persona-suffixed file.
// Auth-mapper variants land under deliverables/auth/<base>_<persona>.md.
// Authz-exploit (graybox + api) lands under deliverables/<base>_<persona>.md.
// Other persona-aware agents (vuln/exploit) reuse the canonical filename
// regardless of persona, so the canonical-path check below covers them.
const PERSONA_SUFFIXED_AUTH_MAPPERS: ReadonlySet<AgentName> = new Set<AgentName>([
  'auth-mapper',
  'mobile-auth-mapper',
  'api-auth-mapper',
]);

const PERSONA_SUFFIXED_AUTHZ_EXPLOITS: ReadonlySet<AgentName> = new Set<AgentName>([
  'graybox-authz-exploit',
  'api-authz-exploit',
]);

/**
 * Compute the on-disk path of an agent's expected deliverable.
 *
 * Defaults to `<workspace>/deliverables/<filename>`. Persona-aware agents
 * override the default with persona-suffixed paths that match what the
 * agent prompt actually writes.
 */
function getExpectedDeliverablePath(
  workspacePath: string,
  agentName: AgentName,
  personaName?: string
): string {
  const baseFilename = AGENTS[agentName].deliverableFilename;
  if (personaName && PERSONA_SUFFIXED_AUTH_MAPPERS.has(agentName)) {
    const stem = baseFilename.replace(/\.md$/, '');
    return path.join(workspacePath, 'deliverables', 'auth', `${stem}_${personaName}.md`);
  }
  if (personaName && PERSONA_SUFFIXED_AUTHZ_EXPLOITS.has(agentName)) {
    const stem = baseFilename.replace(/\.md$/, '');
    return path.join(workspacePath, 'deliverables', `${stem}_${personaName}.md`);
  }
  return path.join(workspacePath, 'deliverables', baseFilename);
}

/**
 * Input for agent execution.
 *
 * `repoPath` is the read-only docs folder surfaced to the prompt via
 * {{REPO_PATH}}. `workspacePath` is the agent's cwd and deliverables root —
 * anything the agent writes (checkpoints, deliverables, logs) lands there,
 * never in repoPath.
 */
export interface AgentExecutionInput {
  webUrl: string;
  repoPath: string;
  workspacePath: string;
  configPath?: string | undefined;
  pipelineTestingMode?: boolean | undefined;
  attemptNumber: number;
  // Mobile-specific fields (set when pipeline.target is 'mobile')
  bundleId?: string | undefined;
  deviceId?: string | undefined;
  appiumUrl?: string | undefined;
  appPath?: string | undefined;
  platform?: string | undefined;
  backendApiUrl?: string | undefined;
  // Persona running this agent (only set for persona-specific phases).
  personaName?: string | undefined;
  // Bridges Temporal activity cancellation into the SDK. Wired by
  // runAgentActivity in src/temporal/activities.ts so a StartToClose / heartbeat
  // timeout aborts the SDK iterator instead of leaving an orphaned process that
  // keeps billing API calls until maxTurns.
  abortController?: AbortController | undefined;
}

interface FailAgentOpts {
  attemptNumber: number;
  result: ClaudePromptResult;
  rollbackReason: string;
  errorMessage: string;
  errorCode: ErrorCode;
  category: PentestErrorType;
  retryable: boolean;
  context: Record<string, unknown>;
}

/**
 * Service for executing agents with full lifecycle management.
 *
 * NOTE: AuditSession is passed per-execution, NOT stored on the service.
 * This is critical for parallel agent execution - each agent needs its own
 * AuditSession instance because AuditSession uses instance state (currentAgentName)
 * to track which agent is currently logging.
 */
export class AgentExecutionService {
  private readonly configLoader: ConfigLoaderService;

  constructor(configLoader: ConfigLoaderService) {
    this.configLoader = configLoader;
  }

  /**
   * Execute an agent with full lifecycle management.
   *
   * @param agentName - Name of the agent to execute
   * @param input - Execution input parameters
   * @param auditSession - Audit session for this specific agent execution
   * @returns Result containing AgentEndResult on success, PentestError on failure
   */
  async execute(
    agentName: AgentName,
    input: AgentExecutionInput,
    auditSession: AuditSession,
    logger: ActivityLogger
  ): Promise<Result<AgentEndResult, PentestError>> {
    const { webUrl, repoPath, workspacePath, configPath, pipelineTestingMode = false, attemptNumber } = input;

    // 0. Idempotency short-circuit. Temporal retries an activity from scratch
    //    after StartToClose timeout, even when the agent already produced its
    //    deliverable in the killed attempt. Without this guard each retry costs
    //    another full SDK run (~$3 / ~2h for discovery). Mirrors the disk check
    //    used by loadResumeState in src/temporal/activities.ts.
    const expectedDeliverable = getExpectedDeliverablePath(workspacePath, agentName, input.personaName);
    if (await fileExists(expectedDeliverable)) {
      logger.info(
        `Deliverable already exists for ${agentName} at ${expectedDeliverable} — skipping execution (idempotent retry)`
      );
      return ok({
        attemptNumber,
        duration_ms: 0,
        cost_usd: 0,
        success: true,
      });
    }

    // 1. Load config (if provided)
    const configResult = await this.configLoader.loadOptional(configPath);
    if (isErr(configResult)) {
      return configResult;
    }
    const distributedConfig = configResult.value;

    // 2. Load prompt
    const promptTemplate = AGENTS[agentName].promptTemplate;
    let prompt: string;
    try {
      prompt = await loadPrompt(
        promptTemplate,
        {
          webUrl,
          repoPath,
          srcPath: path.join(repoPath, 'src'),
          ...(input.bundleId && { bundleId: input.bundleId }),
          ...(input.deviceId && { deviceId: input.deviceId }),
          ...(input.appiumUrl && { appiumUrl: input.appiumUrl }),
          ...(input.appPath && { appPath: input.appPath }),
          ...(input.platform && { platform: input.platform }),
          ...(input.backendApiUrl && { backendApiUrl: input.backendApiUrl }),
          ...(input.personaName && { personaName: input.personaName }),
        },
        distributedConfig,
        pipelineTestingMode,
        logger
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return err(
        new PentestError(
          `Failed to load prompt for ${agentName}: ${errorMessage}`,
          'prompt',
          false,
          { agentName, promptTemplate, originalError: errorMessage },
          ErrorCode.PROMPT_LOAD_FAILED
        )
      );
    }

    // 3. Create git checkpoint on the workspace (no-op if workspace is not a git repo).
    //    Note: git operations target workspacePath (not repoPath) — the agent's working
    //    area — so rollback/checkpoint semantics apply to generated output, never input docs.
    try {
      await createGitCheckpoint(workspacePath, agentName, attemptNumber, logger);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return err(
        new PentestError(
          `Failed to create git checkpoint for ${agentName}: ${errorMessage}`,
          'filesystem',
          false,
          { agentName, workspacePath, originalError: errorMessage },
          ErrorCode.GIT_CHECKPOINT_FAILED
        )
      );
    }

    // 4. Start audit logging
    await auditSession.startAgent(agentName, prompt, attemptNumber, input.personaName);

    // 5. Execute agent with cwd = workspacePath (deliverables & logs go here)
    const result: ClaudePromptResult = await runClaudePrompt(
      prompt,
      workspacePath,
      '', // context
      agentName, // description
      agentName,
      auditSession,
      logger,
      AGENTS[agentName].modelTier,
      input.personaName,
      input.abortController
    );

    // 6. Spending cap check - defense-in-depth
    if (result.success && (result.turns ?? 0) <= 2 && (result.cost || 0) === 0) {
      const resultText = result.result || '';
      if (isSpendingCapBehavior(result.turns ?? 0, result.cost || 0, resultText)) {
        return this.failAgent(agentName, workspacePath, auditSession, logger, {
          attemptNumber, result,
          rollbackReason: 'spending cap detected',
          errorMessage: `Spending cap likely reached: ${resultText.slice(0, 100)}`,
          errorCode: ErrorCode.SPENDING_CAP_REACHED,
          category: 'billing',
          retryable: true,
          context: { agentName, turns: result.turns, cost: result.cost },
        });
      }
    }

    // 7. Handle execution failure
    if (!result.success) {
      return this.failAgent(agentName, workspacePath, auditSession, logger, {
        attemptNumber, result,
        rollbackReason: 'execution failure',
        errorMessage: result.error || 'Agent execution failed',
        errorCode: ErrorCode.AGENT_EXECUTION_FAILED,
        category: 'validation',
        retryable: result.retryable ?? true,
        context: { agentName, originalError: result.error },
      });
    }

    // 8. Validate output (deliverables are under workspacePath/deliverables/)
    const validationPassed = await validateAgentOutput(
      result,
      agentName,
      workspacePath,
      logger,
      input.personaName
    );
    if (!validationPassed) {
      return this.failAgent(agentName, workspacePath, auditSession, logger, {
        attemptNumber, result,
        rollbackReason: 'validation failure',
        errorMessage: `Agent ${agentName} failed output validation`,
        errorCode: ErrorCode.OUTPUT_VALIDATION_FAILED,
        category: 'validation',
        retryable: true,
        context: { agentName, deliverableFilename: AGENTS[agentName].deliverableFilename },
      });
    }

    // 9. Success - commit deliverables, then capture checkpoint hash
    await commitGitSuccess(workspacePath, agentName, logger);
    const commitHash = await getGitCommitHash(workspacePath);

    const endResult: AgentEndResult = {
      attemptNumber,
      duration_ms: result.duration,
      cost_usd: result.cost || 0,
      success: true,
      model: result.model,
      ...(commitHash && { checkpoint: commitHash }),
    };
    await auditSession.endAgent(agentName, endResult);

    return ok(endResult);
  }

  private async failAgent(
    agentName: AgentName,
    workspacePath: string,
    auditSession: AuditSession,
    logger: ActivityLogger,
    opts: FailAgentOpts
  ): Promise<Result<AgentEndResult, PentestError>> {
    await rollbackGitWorkspace(workspacePath, opts.rollbackReason, logger);

    const endResult: AgentEndResult = {
      attemptNumber: opts.attemptNumber,
      duration_ms: opts.result.duration,
      cost_usd: opts.result.cost || 0,
      success: false,
      model: opts.result.model,
      error: opts.errorMessage,
    };
    await auditSession.endAgent(agentName, endResult);

    return err(
      new PentestError(
        opts.errorMessage,
        opts.category,
        opts.retryable,
        opts.context,
        opts.errorCode
      )
    );
  }

  /**
   * Execute an agent, throwing PentestError on failure.
   *
   * This is the preferred method for Temporal activities, which need to
   * catch errors and classify them into ApplicationFailure. Avoids requiring
   * activities to import Result utilities, keeping the boundary clean.
   *
   * @param agentName - Name of the agent to execute
   * @param input - Execution input parameters
   * @param auditSession - Audit session for this specific agent execution
   * @returns AgentEndResult on success
   * @throws PentestError on failure
   */
  async executeOrThrow(
    agentName: AgentName,
    input: AgentExecutionInput,
    auditSession: AuditSession,
    logger: ActivityLogger
  ): Promise<AgentEndResult> {
    const result = await this.execute(agentName, input, auditSession, logger);
    if (isErr(result)) {
      throw result.error;
    }
    return result.value;
  }

  /**
   * Convert AgentEndResult to AgentMetrics for workflow state.
   */
  static toMetrics(endResult: AgentEndResult, result: ClaudePromptResult): AgentMetrics {
    return {
      durationMs: endResult.duration_ms,
      inputTokens: null, // Not currently exposed by SDK wrapper
      outputTokens: null,
      costUsd: endResult.cost_usd,
      numTurns: result.turns ?? null,
      model: result.model,
    };
  }
}
