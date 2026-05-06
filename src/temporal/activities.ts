// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Temporal activities for Shannon agent execution.
 *
 * Each activity wraps service calls with Temporal-specific concerns:
 * - Heartbeat loop (2s interval) to signal worker liveness
 * - Error classification into ApplicationFailure
 * - Container lifecycle management
 *
 * Business logic is delegated to services in src/services/.
 */

import { heartbeat, ApplicationFailure, Context } from '@temporalio/activity';
import path from 'path';
import fs from 'fs/promises';

import { classifyErrorForTemporal, PentestError } from '../services/error-handling.js';
import { ErrorCode } from '../types/errors.js';
import { getOrCreateContainer, getContainer, removeContainer } from '../services/container.js';
import { ExploitationCheckerService } from '../services/exploitation-checker.js';
import type { VulnType, ExploitationDecision } from '../services/queue-validation.js';
import { AuditSession } from '../audit/index.js';
import type { WorkflowSummary } from '../audit/workflow-logger.js';
import type { AgentName } from '../types/agents.js';
import { ALL_AGENTS } from '../types/agents.js';
import type { AgentMetrics, ResumeState } from './shared.js';
import { copyDeliverablesToAudit, type SessionMetadata } from '../audit/utils.js';
import { readJson, fileExists } from '../utils/file-io.js';
import { assembleFinalReport, injectModelIntoReport } from '../services/reporting.js';
import { aggregatePersonaAuthMaps } from '../services/auth-map-aggregator.js';
import { AGENTS } from '../session-manager.js';
import { executeGitCommandWithRetry, isGitRepository } from '../services/git-manager.js';
import type { ResumeAttempt } from '../audit/metrics-tracker.js';
import { createActivityLogger } from './activity-logger.js';
import { runPreflightChecks } from '../services/preflight.js';
import { isErr } from '../types/result.js';

// Max lengths to prevent Temporal protobuf buffer overflow
const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_STACK_TRACE_LENGTH = 1000;

// Max retries for output validation errors (agent didn't save deliverables)
const MAX_OUTPUT_VALIDATION_RETRIES = 3;

const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Input for all agent activities.
 */
export interface ActivityInput {
  webUrl: string;
  // Read-only project docs folder (see PipelineInput for semantics).
  repoPath: string;
  // Agent cwd + deliverables root (see PipelineInput for semantics).
  workspacePath: string;
  configPath?: string;
  outputPath?: string;
  pipelineTestingMode?: boolean;
  pipelineMode?: 'whitebox' | 'graybox';
  pipelineTarget?: 'web' | 'mobile' | 'api';
  workflowId: string;
  sessionId: string;
  // Mobile-specific fields
  appPath?: string;
  platform?: 'android' | 'ios';
  deviceId?: string;
  appiumUrl?: string;
  backendApiUrl?: string;
  bundleId?: string;
  // Persona context — set for persona-specific agent invocations (auth-mapper,
  // vuln/exploit). Discovery and report run shared (no persona). The exploit-authz
  // agent is the only one that reads ALL persona token files for cross-role tests.
  personaName?: string;
}

/**
 * Truncate error message to prevent buffer overflow in Temporal serialization.
 */
function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 20) + '\n[truncated]';
}

/**
 * Truncate stack trace on an ApplicationFailure to prevent buffer overflow.
 */
function truncateStackTrace(failure: ApplicationFailure): void {
  if (failure.stack && failure.stack.length > MAX_STACK_TRACE_LENGTH) {
    failure.stack = failure.stack.slice(0, MAX_STACK_TRACE_LENGTH) + '\n[stack truncated]';
  }
}

/**
 * Build SessionMetadata from ActivityInput.
 */
function buildSessionMetadata(input: ActivityInput): SessionMetadata {
  const { webUrl, repoPath, outputPath, sessionId } = input;
  return {
    id: sessionId,
    webUrl,
    repoPath,
    ...(outputPath && { outputPath }),
  };
}

/**
 * Core activity implementation using services.
 *
 * Executes a single agent with:
 * 1. Heartbeat loop for worker liveness
 * 2. Container creation/reuse
 * 3. Service-based agent execution
 * 4. Error classification for Temporal retry
 */
async function runAgentActivity(
  agentName: AgentName,
  input: ActivityInput
): Promise<AgentMetrics> {
  const { repoPath, workspacePath, configPath, pipelineTestingMode = false, workflowId, webUrl } = input;
  const startTime = Date.now();
  const attemptNumber = Context.current().info.attempt;

  // Bridge Temporal cancellation → SDK abort. Without this, when Temporal
  // cancels the activity (StartToClose / heartbeat timeout, workflow cancel),
  // Node keeps the for-await loop alive in claude-executor.ts and the SDK
  // continues making API calls until maxTurns. The orphan can outlive the
  // workflow by hours and silently bills tokens.
  const abortController = new AbortController();
  const cancellationSignal = Context.current().cancellationSignal;
  if (cancellationSignal.aborted) {
    abortController.abort();
  } else {
    cancellationSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  // Heartbeat loop - signals worker is alive to Temporal server
  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    heartbeat({ agent: agentName, elapsedSeconds: elapsed, attempt: attemptNumber });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const logger = createActivityLogger();

    // 1. Build session metadata and get/create container
    const sessionMetadata = buildSessionMetadata(input);
    const container = getOrCreateContainer(workflowId, sessionMetadata);

    // 2. Create audit session for THIS agent execution
    // NOTE: Each agent needs its own AuditSession because AuditSession uses
    // instance state (currentAgentName) that cannot be shared across parallel agents
    const auditSession = new AuditSession(sessionMetadata);
    await auditSession.initialize(workflowId);

    // 3. Execute agent via service (throws PentestError on failure)
    const endResult = await container.agentExecution.executeOrThrow(
      agentName,
      {
        webUrl,
        repoPath,
        workspacePath,
        configPath,
        pipelineTestingMode,
        attemptNumber,
        abortController,
        ...(input.bundleId && { bundleId: input.bundleId }),
        ...(input.deviceId && { deviceId: input.deviceId }),
        ...(input.appiumUrl && { appiumUrl: input.appiumUrl }),
        ...(input.appPath && { appPath: input.appPath }),
        ...(input.platform && { platform: input.platform }),
        ...(input.backendApiUrl && { backendApiUrl: input.backendApiUrl }),
        ...(input.personaName && { personaName: input.personaName }),
      },
      auditSession,
      logger
    );

    // 4. Return metrics
    return {
      durationMs: Date.now() - startTime,
      inputTokens: null,
      outputTokens: null,
      costUsd: endResult.cost_usd,
      numTurns: null,
      model: endResult.model,
    };
  } catch (error) {
    // If error is already an ApplicationFailure, re-throw directly
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    // Check if output validation retry limit reached (PentestError with code)
    if (
      error instanceof PentestError &&
      error.code === ErrorCode.OUTPUT_VALIDATION_FAILED &&
      attemptNumber >= MAX_OUTPUT_VALIDATION_RETRIES
    ) {
      throw ApplicationFailure.nonRetryable(
        `Agent ${agentName} failed output validation after ${attemptNumber} attempts`,
        'OutputValidationError',
        [{ agentName, attemptNumber, elapsed: Date.now() - startTime }]
      );
    }

    // Classify error for Temporal retry behavior
    const classified = classifyErrorForTemporal(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = truncateErrorMessage(rawMessage);

    if (classified.retryable) {
      const failure = ApplicationFailure.create({
        message,
        type: classified.type,
        details: [{ agentName, attemptNumber, elapsed: Date.now() - startTime }],
      });
      truncateStackTrace(failure);
      throw failure;
    } else {
      const failure = ApplicationFailure.nonRetryable(message, classified.type, [
        { agentName, attemptNumber, elapsed: Date.now() - startTime },
      ]);
      truncateStackTrace(failure);
      throw failure;
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// DISABLED: whitebox activity exports — runtime deprecated. Kept as reference.
// Uncomment (and re-enable WHITEBOX_AGENTS in src/types/agents.ts plus the
// corresponding AGENTS entries in src/session-manager.ts) to restore.
// export async function runPreReconAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('pre-recon', input);
// }
//
// export async function runReconAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('recon', input);
// }
//
// export async function runInjectionVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('injection-vuln', input);
// }
//
// export async function runXssVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('xss-vuln', input);
// }
//
// export async function runAuthVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('auth-vuln', input);
// }
//
// export async function runSsrfVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('ssrf-vuln', input);
// }
//
// export async function runAuthzVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('authz-vuln', input);
// }
//
// export async function runInjectionExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('injection-exploit', input);
// }
//
// export async function runXssExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('xss-exploit', input);
// }
//
// export async function runAuthExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('auth-exploit', input);
// }
//
// export async function runSsrfExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('ssrf-exploit', input);
// }
//
// export async function runAuthzExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('authz-exploit', input);
// }
//
// export async function runReportAgent(input: ActivityInput): Promise<AgentMetrics> {
//   return runAgentActivity('report', input);
// }

// Gray-box activities
export async function runDiscoveryAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('discovery', input);
}

export async function runAuthMapperAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('auth-mapper', input);
}

// Gray-box vulnerability analysis agents
export async function runGrayboxInjectionVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-injection-vuln', input);
}

export async function runGrayboxXssVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-xss-vuln', input);
}

export async function runGrayboxAuthVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-auth-vuln', input);
}

export async function runGrayboxSsrfVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-ssrf-vuln', input);
}

export async function runGrayboxAuthzVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-authz-vuln', input);
}

// Gray-box exploitation agents
export async function runGrayboxInjectionExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-injection-exploit', input);
}

export async function runGrayboxXssExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-xss-exploit', input);
}

export async function runGrayboxAuthExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-auth-exploit', input);
}

export async function runGrayboxSsrfExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-ssrf-exploit', input);
}

export async function runGrayboxAuthzExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-authz-exploit', input);
}

export async function runGrayboxReportAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('graybox-report', input);
}

// Mobile graybox activities
export async function runMobileDiscoveryAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-discovery', input);
}

export async function runMobileAuthMapperAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-auth-mapper', input);
}

export async function runMobileInjectionVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-injection-vuln', input);
}

export async function runMobileXssVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-xss-vuln', input);
}

export async function runMobileAuthVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-auth-vuln', input);
}

export async function runMobileSsrfVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-ssrf-vuln', input);
}

export async function runMobileAuthzVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-authz-vuln', input);
}

export async function runMobileInjectionExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-injection-exploit', input);
}

export async function runMobileXssExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-xss-exploit', input);
}

export async function runMobileAuthExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-auth-exploit', input);
}

export async function runMobileSsrfExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-ssrf-exploit', input);
}

export async function runMobileAuthzExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-authz-exploit', input);
}

export async function runMobileReportAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('mobile-report', input);
}

// API graybox activities
export async function runApiDiscoveryAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-discovery', input);
}

export async function runApiAuthMapperAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-auth-mapper', input);
}

export async function runApiInjectionVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-injection-vuln', input);
}

export async function runApiXssVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-xss-vuln', input);
}

export async function runApiAuthVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-auth-vuln', input);
}

export async function runApiSsrfVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-ssrf-vuln', input);
}

export async function runApiAuthzVulnAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-authz-vuln', input);
}

export async function runApiInjectionExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-injection-exploit', input);
}

export async function runApiXssExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-xss-exploit', input);
}

export async function runApiAuthExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-auth-exploit', input);
}

export async function runApiSsrfExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-ssrf-exploit', input);
}

export async function runApiAuthzExploitAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-authz-exploit', input);
}

export async function runApiReportAgent(input: ActivityInput): Promise<AgentMetrics> {
  return runAgentActivity('api-report', input);
}

/**
 * Preflight validation activity.
 *
 * Runs cheap checks before any agent execution:
 * 1. Repository path exists with .git
 * 2. Config file validates (if provided)
 * 3. Credential validation (API key, OAuth, or router mode)
 *
 * NOT using runAgentActivity — preflight doesn't run an agent via the SDK.
 */
export async function runPreflightValidation(input: ActivityInput): Promise<void> {
  const startTime = Date.now();
  const attemptNumber = Context.current().info.attempt;

  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    heartbeat({ phase: 'preflight', elapsedSeconds: elapsed, attempt: attemptNumber });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const logger = createActivityLogger();
    logger.info('Running preflight validation...', { attempt: attemptNumber });

    const result = await runPreflightChecks(input.repoPath, input.configPath, logger, input.pipelineTarget || 'web');

    if (isErr(result)) {
      const classified = classifyErrorForTemporal(result.error);
      const message = truncateErrorMessage(result.error.message);

      if (classified.retryable) {
        const failure = ApplicationFailure.create({
          message,
          type: classified.type,
          details: [{ phase: 'preflight', attemptNumber, elapsed: Date.now() - startTime }],
        });
        truncateStackTrace(failure);
        throw failure;
      } else {
        const failure = ApplicationFailure.nonRetryable(message, classified.type, [
          { phase: 'preflight', attemptNumber, elapsed: Date.now() - startTime },
        ]);
        truncateStackTrace(failure);
        throw failure;
      }
    }

    logger.info('Preflight validation passed');
  } catch (error) {
    if (error instanceof ApplicationFailure) {
      throw error;
    }

    const classified = classifyErrorForTemporal(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = truncateErrorMessage(rawMessage);

    const failure = ApplicationFailure.nonRetryable(message, classified.type, [
      { phase: 'preflight', attemptNumber, elapsed: Date.now() - startTime },
    ]);
    truncateStackTrace(failure);
    throw failure;
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Assemble the final report by concatenating exploitation evidence files.
 */
export async function assembleReportActivity(input: ActivityInput): Promise<void> {
  // DISABLED: whitebox runtime deprecated — default mode is now 'graybox'.
  const { workspacePath, pipelineMode = 'graybox', pipelineTarget = 'web' } = input;
  const reportMode = pipelineTarget === 'api'
    ? 'api' as const
    : pipelineTarget === 'mobile'
      ? 'mobile' as const
      : pipelineMode;
  const logger = createActivityLogger();
  logger.info('Assembling deliverables from specialist agents...');
  try {
    await assembleFinalReport(workspacePath, logger, reportMode);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Error assembling final report: ${err.message}`);
  }
}

/**
 * Merge per-persona auth maps into the canonical graybox_auth_map.md.
 *
 * Runs after the auth-mapper phase completes. Failures are logged but do not
 * abort the workflow — downstream agents can still read per-persona files
 * directly from deliverables/auth/.
 */
export async function aggregateAuthMapsActivity(input: ActivityInput): Promise<void> {
  const { workspacePath } = input;
  const logger = createActivityLogger();
  logger.info('Aggregating per-persona auth maps...');
  try {
    await aggregatePersonaAuthMaps(workspacePath, logger);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Error aggregating persona auth maps: ${err.message}`);
  }
}

/**
 * Inject model metadata into the final report.
 */
export async function injectReportMetadataActivity(input: ActivityInput): Promise<void> {
  const { workspacePath, sessionId, outputPath } = input;
  const logger = createActivityLogger();
  const effectiveOutputPath = outputPath
    ? path.join(outputPath, sessionId)
    : path.join('./audit-logs', sessionId);
  try {
    await injectModelIntoReport(workspacePath, effectiveOutputPath, logger);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Error injecting model into report: ${err.message}`);
  }
}

/**
 * Check if exploitation should run for a given vulnerability type.
 *
 * Uses existing container if available (from prior agent runs),
 * otherwise creates service directly (stateless, no dependencies).
 */
export async function checkExploitationQueue(
  input: ActivityInput,
  vulnType: VulnType
): Promise<ExploitationDecision> {
  const { workspacePath, workflowId } = input;
  const logger = createActivityLogger();

  // Reuse container's service if available (from prior vuln agent runs)
  const existingContainer = getContainer(workflowId);
  const checker = existingContainer?.exploitationChecker ?? new ExploitationCheckerService();

  // Queue JSON is written by vuln agents under {workspacePath}/deliverables/
  return checker.checkQueue(vulnType, workspacePath, logger);
}

interface SessionJson {
  session: {
    id: string;
    webUrl: string;
    repoPath?: string;
    originalWorkflowId?: string;
    resumeAttempts?: ResumeAttempt[];
  };
  metrics: {
    agents: Record<
      string,
      {
        status: 'in-progress' | 'success' | 'failed';
        checkpoint?: string;
      }
    >;
  };
}

// Per-persona file patterns for agents that fan out across personas.
// Each entry maps an unqualified agent name to the regex extracting the
// persona name from a deliverable filename under deliverables/auth/.
const PERSONA_AGENT_FILE_PATTERNS: Record<string, RegExp> = {
  'auth-mapper': /^graybox_auth_map_(.+)\.md$/,
};

/**
 * Inspect deliverables/auth/ for per-persona auth-mapper outputs and append
 * qualified `<persona>/<agentName>` entries to completedAgents in-place.
 *
 * The unqualified entry was already pushed by the caller in step 3 when the
 * canonical deliverable exists. This function adds the per-persona detail so
 * the resume can skip individual personas inside runAuthMapperPhase.
 */
async function augmentWithPersonaCompletions(
  completedAgents: string[],
  expectedWorkspacePath: string
): Promise<void> {
  const authDir = path.join(expectedWorkspacePath, 'deliverables', 'auth');

  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const [agentName, pattern] of Object.entries(PERSONA_AGENT_FILE_PATTERNS)) {
    if (!completedAgents.includes(agentName)) {
      continue;
    }
    for (const filename of entries) {
      const match = filename.match(pattern);
      if (match && match[1]) {
        const qualified = `${match[1]}/${agentName}`;
        if (!completedAgents.includes(qualified)) {
          completedAgents.push(qualified);
        }
      }
    }
  }
}

/**
 * Load resume state from an existing workspace.
 *
 * `expectedWorkspacePath` is the agent's workspace (./audit-logs/<sessionId>/),
 * which is where deliverables live. Historically this arg was the repo path
 * (source code / docs folder), but deliverables are no longer stored there.
 */
export async function loadResumeState(
  workspaceName: string,
  expectedUrl: string,
  expectedWorkspacePath: string,
  personaNames: readonly string[] = []
): Promise<ResumeState> {
  // 1. Validate workspace exists
  const sessionPath = path.join('./audit-logs', workspaceName, 'session.json');

  const exists = await fileExists(sessionPath);
  if (!exists) {
    throw ApplicationFailure.nonRetryable(
      `Workspace not found: ${workspaceName}\nExpected path: ${sessionPath}`,
      'WorkspaceNotFoundError'
    );
  }

  // 2. Parse session.json and validate URL match
  let session: SessionJson;
  try {
    session = await readJson<SessionJson>(sessionPath);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw ApplicationFailure.nonRetryable(
      `Corrupted session.json in workspace ${workspaceName}: ${errorMsg}`,
      'CorruptedSessionError'
    );
  }

  if (session.session.webUrl !== expectedUrl) {
    throw ApplicationFailure.nonRetryable(
      `URL mismatch with workspace\n  Workspace URL: ${session.session.webUrl}\n  Provided URL:  ${expectedUrl}`,
      'URLMismatchError'
    );
  }

  // 3. Cross-check agent status with deliverables on disk
  const completedAgents: string[] = [];
  const agents = session.metrics.agents;

  for (const agentName of ALL_AGENTS) {
    const agentData = agents[agentName];
    if (!agentData || agentData.status !== 'success') {
      continue;
    }

    const deliverableFilename = AGENTS[agentName].deliverableFilename;
    const deliverablePath = `${expectedWorkspacePath}/deliverables/${deliverableFilename}`;
    const deliverableExists = await fileExists(deliverablePath);

    if (!deliverableExists) {
      const logger = createActivityLogger();
      logger.warn(`Agent ${agentName} shows success but deliverable missing, will re-run`);
      continue;
    }

    completedAgents.push(agentName);
  }

  // 3b. Fan out qualified `<persona>/<agentName>` entries for every completed
  // agent. The vuln/exploit pipeline phase (workflows.ts:runPipelinePhase) and
  // the auth-mapper phase (workflows.ts:runAuthMapperPhase) check skip using
  // qualified names, but session.json only stores unqualified names — without
  // this fan-out, persona-aware phases re-run every completed agent and
  // overwrite their deliverables.
  const unqualifiedSnapshot = [...completedAgents];
  for (const agentName of unqualifiedSnapshot) {
    for (const persona of personaNames) {
      const qualified = `${persona}/${agentName}`;
      if (!completedAgents.includes(qualified)) {
        completedAgents.push(qualified);
      }
    }
  }

  // 3c. Safety net for auth-mapper — also scan per-persona files on disk in
  // case session.json was written before fan-out existed (older runs).
  await augmentWithPersonaCompletions(completedAgents, expectedWorkspacePath);

  // 4. Validate that at least one agent completed with deliverables
  if (completedAgents.length === 0) {
    const successAgents = Object.entries(agents)
      .filter(([, data]) => data.status === 'success')
      .map(([name]) => name);

    throw ApplicationFailure.nonRetryable(
      `Cannot resume workspace ${workspaceName}: ` +
        (successAgents.length > 0
          ? `${successAgents.length} agent(s) show success in session.json (${successAgents.join(', ')}) ` +
            `but their deliverable files are missing from disk. ` +
            `Start a fresh run instead.`
          : `No agents completed successfully. Start a fresh run instead.`),
      'NoCheckpointsError'
    );
  }

  // 5. Find the most recent git checkpoint (optional — mobile workspaces may lack git history)
  const checkpoints = completedAgents
    .map((name) => agents[name]?.checkpoint)
    .filter((hash): hash is string => hash != null);

  let checkpointHash: string;
  if (checkpoints.length > 0) {
    checkpointHash = await findLatestCommit(expectedWorkspacePath, checkpoints);
  } else {
    // No git checkpoints — use HEAD or empty hash (workspace without git history)
    checkpointHash = 'HEAD';
  }
  const originalWorkflowId = session.session.originalWorkflowId || session.session.id;

  // 6. Log summary and return resume state
  const logger = createActivityLogger();
  logger.info('Resume state loaded', {
    workspace: workspaceName,
    completedAgents: completedAgents.length,
    checkpoint: checkpointHash,
  });

  return {
    workspaceName,
    originalUrl: session.session.webUrl,
    completedAgents,
    checkpointHash,
    originalWorkflowId,
  };
}

async function findLatestCommit(repoPath: string, commitHashes: string[]): Promise<string> {
  if (commitHashes.length === 1) {
    const hash = commitHashes[0];
    if (!hash) {
      throw new PentestError(
        'Empty commit hash in array',
        'filesystem',
        false, // Non-retryable - corrupt workspace state
        { phase: 'resume' },
        ErrorCode.GIT_CHECKPOINT_FAILED
      );
    }
    return hash;
  }

  const result = await executeGitCommandWithRetry(
    ['git', 'rev-list', '--max-count=1', ...commitHashes],
    repoPath,
    'find latest commit'
  );

  return result.stdout.trim();
}

/**
 * Restore git workspace to a checkpoint and clean up partial deliverables.
 * The workspace is ./audit-logs/<sessionId>/. Git ops are skipped if the
 * workspace isn't a git repo (graybox workspaces typically aren't).
 */
export async function restoreGitCheckpoint(
  workspacePath: string,
  checkpointHash: string,
  incompleteAgents: AgentName[]
): Promise<void> {
  const logger = createActivityLogger();
  logger.info(`Restoring workspace to ${checkpointHash}...`);

  const isGit = await isGitRepository(workspacePath);
  if (isGit && checkpointHash !== 'HEAD') {
    await executeGitCommandWithRetry(
      ['git', 'reset', '--hard', checkpointHash],
      workspacePath,
      'reset to checkpoint for resume'
    );
    await executeGitCommandWithRetry(
      ['git', 'clean', '-fd', '-e', 'agents', '-e', 'prompts', '-e', 'deliverables'],
      workspacePath,
      'clean untracked files for resume'
    );
  } else {
    logger.info('Skipping git reset (workspace is not a git repo or no checkpoint)');
  }

  for (const agentName of incompleteAgents) {
    const deliverableFilename = AGENTS[agentName].deliverableFilename;
    const deliverablePath = `${workspacePath}/deliverables/${deliverableFilename}`;
    try {
      const exists = await fileExists(deliverablePath);
      if (exists) {
        logger.warn(`Cleaning partial deliverable: ${agentName}`);
        await fs.unlink(deliverablePath);
      }
    } catch (error) {
      logger.info(`Note: Failed to delete ${deliverablePath}: ${error}`);
    }
  }

  logger.info('Workspace restored to clean state');
}

/**
 * Record a resume attempt in session.json and write resume header to workflow.log.
 */
export async function recordResumeAttempt(
  input: ActivityInput,
  terminatedWorkflows: string[],
  checkpointHash: string,
  previousWorkflowId: string,
  completedAgents: string[]
): Promise<void> {
  const sessionMetadata = buildSessionMetadata(input);
  const auditSession = new AuditSession(sessionMetadata);
  await auditSession.initialize();

  // Update session.json with resume attempt
  await auditSession.addResumeAttempt(input.workflowId, terminatedWorkflows, checkpointHash);

  // Write resume header to workflow.log
  await auditSession.logResumeHeader({
    previousWorkflowId,
    newWorkflowId: input.workflowId,
    checkpointHash,
    completedAgents,
  });
}

/**
 * Log phase transition to the unified workflow log.
 */
export async function logPhaseTransition(
  input: ActivityInput,
  phase: string,
  event: 'start' | 'complete'
): Promise<void> {
  const sessionMetadata = buildSessionMetadata(input);
  const auditSession = new AuditSession(sessionMetadata);
  await auditSession.initialize(input.workflowId);

  if (event === 'start') {
    await auditSession.logPhaseStart(phase);
  } else {
    await auditSession.logPhaseComplete(phase);
  }
}

/**
 * Log workflow completion with full summary.
 * Cleans up container when done.
 */
export async function logWorkflowComplete(
  input: ActivityInput,
  summary: WorkflowSummary
): Promise<void> {
  const { workspacePath, workflowId } = input;
  const sessionMetadata = buildSessionMetadata(input);

  // 1. Initialize audit session and mark final status
  const auditSession = new AuditSession(sessionMetadata);
  await auditSession.initialize(workflowId);
  await auditSession.updateSessionStatus(summary.status);

  // 2. Load cumulative metrics from session.json
  const sessionData = (await auditSession.getMetrics()) as {
    metrics: {
      total_duration_ms: number;
      total_cost_usd: number;
      agents: Record<string, { final_duration_ms: number; total_cost_usd: number }>;
    };
  };

  // 3. Fill in metrics for skipped agents (resumed from previous run)
  const agentMetrics = { ...summary.agentMetrics };
  for (const agentName of summary.completedAgents) {
    if (!agentMetrics[agentName]) {
      const agentData = sessionData.metrics.agents[agentName];
      if (agentData) {
        agentMetrics[agentName] = {
          durationMs: agentData.final_duration_ms,
          costUsd: agentData.total_cost_usd,
        };
      }
    }
  }

  // 4. Build cumulative summary with cross-run totals
  const cumulativeSummary: WorkflowSummary = {
    ...summary,
    totalDurationMs: sessionData.metrics.total_duration_ms,
    totalCostUsd: sessionData.metrics.total_cost_usd,
    agentMetrics,
  };

  // 5. Write completion entry to workflow.log
  await auditSession.logWorkflowComplete(cumulativeSummary);

  // 6. Copy deliverables to audit-logs (no-op when workspacePath is already the audit dir)
  try {
    await copyDeliverablesToAudit(sessionMetadata, workspacePath);
  } catch (copyErr) {
    const logger = createActivityLogger();
    logger.error('Failed to copy deliverables to audit-logs', {
      error: copyErr instanceof Error ? copyErr.message : String(copyErr),
    });
  }

  // 7. Clean up container
  removeContainer(workflowId);
}
