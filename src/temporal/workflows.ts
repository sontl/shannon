// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Temporal workflow for Shannon pentest pipeline.
 *
 * Orchestrates the penetration testing workflow:
 * 1. Pre-Reconnaissance (sequential)
 * 2. Reconnaissance (sequential)
 * 3-4. Vulnerability + Exploitation (5 pipelined pairs in parallel)
 *      Each pair: vuln agent → queue check → conditional exploit
 *      No synchronization barrier - exploits start when their vuln finishes
 * 5. Reporting (sequential)
 *
 * Features:
 * - Queryable state via getProgress
 * - Automatic retry with backoff for transient/billing errors
 * - Non-retryable classification for permanent errors
 * - Audit correlation via workflowId
 * - Graceful failure handling: pipelines continue if one fails
 */

import {
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { ActivityInput } from './activities.js';
import {
  getProgress,
  type PipelineInput,
  type PipelineState,
  type PipelineProgress,
  type PipelineSummary,
  type VulnExploitPipelineResult,
  type AgentMetrics,
  type ResumeState,
} from './shared.js';
import type { AgentName, VulnType } from '../types/agents.js';
import { ALL_AGENTS, GRAYBOX_AGENTS, WHITEBOX_AGENTS, MOBILE_GRAYBOX_AGENTS, API_GRAYBOX_AGENTS } from '../types/agents.js';
import { toWorkflowSummary } from './summary-mapper.js';
import { formatWorkflowError } from './workflow-errors.js';

// Retry configuration for production (long intervals for billing recovery)
const PRODUCTION_RETRY = {
  initialInterval: '5 minutes',
  maximumInterval: '30 minutes',
  backoffCoefficient: 2,
  maximumAttempts: 50,
  nonRetryableErrorTypes: [
    'AuthenticationError',
    'PermissionError',
    'InvalidRequestError',
    'RequestTooLargeError',
    'ConfigurationError',
    'InvalidTargetError',
    'ExecutionLimitError',
  ],
};

// Retry configuration for pipeline testing (fast iteration)
const TESTING_RETRY = {
  initialInterval: '10 seconds',
  maximumInterval: '30 seconds',
  backoffCoefficient: 2,
  maximumAttempts: 5,
  nonRetryableErrorTypes: PRODUCTION_RETRY.nonRetryableErrorTypes,
};

// Activity proxy with production retry configuration (default)
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '60 minutes', // Extended for sub-agent execution (SDK blocks event loop during Task tool calls)
  retry: PRODUCTION_RETRY,
});

// Activity proxy with testing retry configuration (fast)
const testActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 minutes', // Extended for sub-agent execution in testing
  retry: TESTING_RETRY,
});

// Retry configuration for subscription plans (5h+ rolling rate limit windows)
const SUBSCRIPTION_RETRY = {
  initialInterval: '5 minutes',
  maximumInterval: '6 hours',
  backoffCoefficient: 2,
  maximumAttempts: 100,
  nonRetryableErrorTypes: PRODUCTION_RETRY.nonRetryableErrorTypes,
};

// Activity proxy for subscription plan recovery (extended timeouts)
const subscriptionActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '8 hours',
  heartbeatTimeout: '2 hours',
  retry: SUBSCRIPTION_RETRY,
});

// Retry configuration for preflight validation (short timeout, few retries)
const PREFLIGHT_RETRY = {
  initialInterval: '10 seconds',
  maximumInterval: '1 minute',
  backoffCoefficient: 2,
  maximumAttempts: 3,
  nonRetryableErrorTypes: PRODUCTION_RETRY.nonRetryableErrorTypes,
};

// Activity proxy for preflight validation (short timeout)
const preflightActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '2 minutes',
  retry: PREFLIGHT_RETRY,
});

/**
 * Compute aggregated metrics from the current pipeline state.
 * Called on both success and failure to provide partial metrics.
 */
function computeSummary(state: PipelineState): PipelineSummary {
  const metrics = Object.values(state.agentMetrics);
  return {
    totalCostUsd: metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    totalDurationMs: Date.now() - state.startTime,
    totalTurns: metrics.reduce((sum, m) => sum + (m.numTurns ?? 0), 0),
    agentCount: state.completedAgents.length,
  };
}

export async function pentestPipelineWorkflow(
  input: PipelineInput
): Promise<PipelineState> {
  const { workflowId } = workflowInfo();

  // Select activity proxy based on mode: testing (fast), subscription (extended), or default
  function selectActivityProxy(pipelineInput: PipelineInput) {
    if (pipelineInput.pipelineTestingMode) return testActs;
    if (pipelineInput.pipelineConfig?.retry_preset === 'subscription') return subscriptionActs;
    return acts;
  }

  const a = selectActivityProxy(input);

  const state: PipelineState = {
    status: 'running',
    currentPhase: null,
    currentAgent: null,
    completedAgents: [],
    failedAgent: null,
    error: null,
    startTime: Date.now(),
    agentMetrics: {},
    summary: null,
  };

  setHandler(getProgress, (): PipelineProgress => ({
    ...state,
    workflowId,
    elapsedMs: Date.now() - state.startTime,
  }));

  // Build ActivityInput with required workflowId for audit correlation
  // Activities require workflowId (non-optional), PipelineInput has it optional
  // Use spread to conditionally include optional properties (exactOptionalPropertyTypes)
  // sessionId is workspace name for resume, or workflowId for new runs
  const sessionId = input.sessionId || input.resumeFromWorkspace || workflowId;

  const activityInput: ActivityInput = {
    webUrl: input.webUrl,
    repoPath: input.repoPath,
    workspacePath: input.workspacePath,
    workflowId,
    sessionId,
    ...(input.configPath !== undefined && { configPath: input.configPath }),
    ...(input.outputPath !== undefined && { outputPath: input.outputPath }),
    ...(input.pipelineTestingMode !== undefined && {
      pipelineTestingMode: input.pipelineTestingMode,
    }),
    ...(input.pipelineConfig?.mode !== undefined && {
      pipelineMode: input.pipelineConfig.mode,
    }),
    ...(input.pipelineConfig?.target !== undefined && {
      pipelineTarget: input.pipelineConfig.target,
    }),
    // Mobile-specific fields
    ...(input.appPath !== undefined && { appPath: input.appPath }),
    ...(input.platform !== undefined && { platform: input.platform }),
    ...(input.deviceId !== undefined && { deviceId: input.deviceId }),
    ...(input.appiumUrl !== undefined && { appiumUrl: input.appiumUrl }),
    ...(input.backendApiUrl !== undefined && { backendApiUrl: input.backendApiUrl }),
    ...(input.bundleId !== undefined && { bundleId: input.bundleId }),
  };

  let resumeState: ResumeState | null = null;

  if (input.resumeFromWorkspace) {
    // 1. Load resume state (validates workspace, cross-checks deliverables)
    resumeState = await a.loadResumeState(
      input.resumeFromWorkspace,
      input.webUrl,
      input.workspacePath
    );

    // 2. Restore git workspace and clean up incomplete deliverables
    const incompleteAgents = ALL_AGENTS.filter(
      (agentName) => !resumeState!.completedAgents.includes(agentName)
    ) as AgentName[];

    await a.restoreGitCheckpoint(
      input.workspacePath,
      resumeState.checkpointHash,
      incompleteAgents
    );

    // 3. Short-circuit if all agents for this mode already completed
    const target = input.pipelineConfig?.target || 'web';
    // DISABLED: whitebox runtime deprecated — default mode is now 'graybox'.
    const mode = input.pipelineConfig?.mode || 'graybox';
    const agentsForMode = target === 'api'
      ? API_GRAYBOX_AGENTS
      : target === 'mobile'
        ? MOBILE_GRAYBOX_AGENTS
        : (mode === 'graybox' ? GRAYBOX_AGENTS : WHITEBOX_AGENTS);
    if (resumeState.completedAgents.length === agentsForMode.length) {
      log.info(`All ${agentsForMode.length} agents already completed. Nothing to resume.`);
      state.status = 'completed';
      state.completedAgents = [...resumeState.completedAgents];
      state.summary = computeSummary(state);
      return state;
    }

    // 4. Record this resume attempt in session.json and workflow.log
    await a.recordResumeAttempt(
      activityInput,
      input.terminatedWorkflows || [],
      resumeState.checkpointHash,
      resumeState.originalWorkflowId,
      resumeState.completedAgents
    );

    log.info('Resume state loaded and workspace restored');
  }

  const shouldSkip = (agentName: string): boolean => {
    return resumeState?.completedAgents.includes(agentName) ?? false;
  };

  // Persona phases are tracked in completedAgents under a qualified name so a
  // single workflow can resume the right slot per persona.
  const qualifiedAgent = (personaName: string, agentName: string): string =>
    `${personaName}/${agentName}`;

  // Per-persona activity input — tags downstream activities/prompts so the
  // agent loads the right credentials and writes persona-suffixed deliverables.
  const withPersona = (personaName: string): ActivityInput => ({
    ...activityInput,
    personaName,
  });

  const personas = input.personas.length > 0 ? input.personas : [{ name: 'default' }];

  // Run a sequential agent phase (shared across personas — discovery, report).
  async function runSequentialPhase(
    phaseName: string,
    agentName: AgentName,
    runAgent: (input: ActivityInput) => Promise<AgentMetrics>
  ): Promise<void> {
    if (!shouldSkip(agentName)) {
      state.currentPhase = phaseName;
      state.currentAgent = agentName;
      await a.logPhaseTransition(activityInput, phaseName, 'start');
      state.agentMetrics[agentName] = await runAgent(activityInput);
      state.completedAgents.push(agentName);
      await a.logPhaseTransition(activityInput, phaseName, 'complete');
    } else {
      log.info(`Skipping ${agentName} (already complete)`);
      state.completedAgents.push(agentName);
    }
  }

  // Run an auth-mapper agent in parallel across all personas.
  async function runAuthMapperPhase(
    agentName: AgentName,
    runAgent: (input: ActivityInput) => Promise<AgentMetrics>
  ): Promise<void> {
    state.currentPhase = 'auth-mapper';
    state.currentAgent = agentName;
    await a.logPhaseTransition(activityInput, 'auth-mapper', 'start');

    const maxConcurrent = input.pipelineConfig?.max_concurrent_pipelines ?? 5;
    const thunks: Array<() => Promise<{ persona: string; metrics: AgentMetrics | null }>> = [];

    for (const persona of personas) {
      const qualified = qualifiedAgent(persona.name, agentName);
      if (shouldSkip(qualified)) {
        log.info(`Skipping ${qualified} (already complete)`);
        state.completedAgents.push(qualified);
        continue;
      }
      thunks.push(async () => {
        const metrics = await runAgent(withPersona(persona.name));
        return { persona: persona.name, metrics };
      });
    }

    if (thunks.length > 0) {
      const results = await runAuthMapperWithLimit(thunks, maxConcurrent);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { persona, metrics } = result.value;
          const qualified = qualifiedAgent(persona, agentName);
          if (metrics) {
            state.agentMetrics[qualified] = metrics;
            state.completedAgents.push(qualified);
          }
        } else {
          log.warn(`auth-mapper persona run failed: ${String(result.reason)}`);
        }
      }
    }

    await a.logPhaseTransition(activityInput, 'auth-mapper', 'complete');
  }

  // Concurrency-bounded runner for auth-mapper persona thunks.
  async function runAuthMapperWithLimit(
    thunks: Array<() => Promise<{ persona: string; metrics: AgentMetrics | null }>>,
    limit: number
  ): Promise<PromiseSettledResult<{ persona: string; metrics: AgentMetrics | null }>[]> {
    const results: PromiseSettledResult<{ persona: string; metrics: AgentMetrics | null }>[] = [];
    const inFlight = new Set<Promise<void>>();
    for (const thunk of thunks) {
      const slot = thunk().then(
        (value) => { results.push({ status: 'fulfilled', value }); },
        (reason: unknown) => { results.push({ status: 'rejected', reason }); }
      ).finally(() => { inFlight.delete(slot); });
      inFlight.add(slot);
      if (inFlight.size >= limit) {
        await Promise.race(inFlight);
      }
    }
    await Promise.allSettled(inFlight);
    return results;
  }

  // DISABLED: whitebox pipeline configs — runtime deprecated. Kept as reference.
  // Uncomment (along with whitebox activity exports in activities.ts and the
  // AGENTS entries in session-manager.ts) to restore.
  // function buildPipelineConfigs(): Array<{
  //   vulnType: VulnType;
  //   vulnAgent: string;
  //   exploitAgent: string;
  //   runVuln: () => Promise<AgentMetrics>;
  //   runExploit: () => Promise<AgentMetrics>;
  // }> {
  //   return [
  //     {
  //       vulnType: 'injection',
  //       vulnAgent: 'injection-vuln',
  //       exploitAgent: 'injection-exploit',
  //       runVuln: () => a.runInjectionVulnAgent(activityInput),
  //       runExploit: () => a.runInjectionExploitAgent(activityInput),
  //     },
  //     {
  //       vulnType: 'xss',
  //       vulnAgent: 'xss-vuln',
  //       exploitAgent: 'xss-exploit',
  //       runVuln: () => a.runXssVulnAgent(activityInput),
  //       runExploit: () => a.runXssExploitAgent(activityInput),
  //     },
  //     {
  //       vulnType: 'auth',
  //       vulnAgent: 'auth-vuln',
  //       exploitAgent: 'auth-exploit',
  //       runVuln: () => a.runAuthVulnAgent(activityInput),
  //       runExploit: () => a.runAuthExploitAgent(activityInput),
  //     },
  //     {
  //       vulnType: 'ssrf',
  //       vulnAgent: 'ssrf-vuln',
  //       exploitAgent: 'ssrf-exploit',
  //       runVuln: () => a.runSsrfVulnAgent(activityInput),
  //       runExploit: () => a.runSsrfExploitAgent(activityInput),
  //     },
  //     {
  //       vulnType: 'authz',
  //       vulnAgent: 'authz-vuln',
  //       exploitAgent: 'authz-exploit',
  //       runVuln: () => a.runAuthzVulnAgent(activityInput),
  //       runExploit: () => a.runAuthzExploitAgent(activityInput),
  //     },
  //   ];
  // }

  // Aggregate results from settled pipeline promises into workflow state
  function aggregatePipelineResults(
    results: PromiseSettledResult<VulnExploitPipelineResult>[]
  ): void {
    const failedPipelines: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { vulnAgent, exploitAgent, vulnMetrics, exploitMetrics } = result.value;

        if (vulnMetrics) {
          state.agentMetrics[vulnAgent] = vulnMetrics;
          state.completedAgents.push(vulnAgent);
        } else if (shouldSkip(vulnAgent)) {
          state.completedAgents.push(vulnAgent);
        }

        if (exploitMetrics) {
          state.agentMetrics[exploitAgent] = exploitMetrics;
          state.completedAgents.push(exploitAgent);
        } else if (shouldSkip(exploitAgent)) {
          state.completedAgents.push(exploitAgent);
        }
      } else {
        const errorMsg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failedPipelines.push(errorMsg);
      }
    }

    if (failedPipelines.length > 0) {
      log.warn(`${failedPipelines.length} pipeline(s) failed`, {
        failures: failedPipelines,
      });
    }
  }

  // Run thunks with a concurrency limit, returning PromiseSettledResult for each.
  // When limit >= thunks.length (default), all launch concurrently — identical to Promise.allSettled.
  // NOTE: Results are in completion order, not input order. Callers must key on value fields, not index.
  async function runWithConcurrencyLimit(
    thunks: Array<() => Promise<VulnExploitPipelineResult>>,
    limit: number
  ): Promise<PromiseSettledResult<VulnExploitPipelineResult>[]> {
    const results: PromiseSettledResult<VulnExploitPipelineResult>[] = [];
    const inFlight = new Set<Promise<void>>();

    for (const thunk of thunks) {
      const slot = thunk().then(
        (value) => { results.push({ status: 'fulfilled', value }); },
        (reason: unknown) => { results.push({ status: 'rejected', reason }); }
      ).finally(() => { inFlight.delete(slot); });

      inFlight.add(slot);

      if (inFlight.size >= limit) {
        await Promise.race(inFlight);
      }
    }

    await Promise.allSettled(inFlight);
    return results;
  }

  try {
    // === Preflight Validation ===
    // Quick sanity checks before committing to expensive agent runs.
    // NOT using runSequentialPhase — preflight doesn't produce AgentMetrics.
    state.currentPhase = 'preflight';
    state.currentAgent = null;
    await preflightActs.runPreflightValidation(activityInput);
    log.info('Preflight validation passed');

    const isGraybox = input.pipelineConfig?.mode === 'graybox';
    const isMobile = input.pipelineConfig?.target === 'mobile';
    const isApi = input.pipelineConfig?.target === 'api';
    log.info(`Pipeline routing: isGraybox=${isGraybox}, isMobile=${isMobile}, isApi=${isApi}, target=${input.pipelineConfig?.target}, mode=${input.pipelineConfig?.mode}`);

    // Run a single vuln→exploit pipeline for a specific persona.
    // vulnAgent/exploitAgent fields in the result are qualified ("<persona>/<agent>")
    // so aggregation can record per-persona completion in resume state.
    async function runVulnExploitPipeline(
      personaName: string,
      vulnType: VulnType,
      vulnAgentName: string,
      exploitAgentName: string,
      runVulnAgent: (input: ActivityInput) => Promise<AgentMetrics>,
      runExploitAgent: (input: ActivityInput) => Promise<AgentMetrics>
    ): Promise<VulnExploitPipelineResult> {
      const qualifiedVuln = qualifiedAgent(personaName, vulnAgentName);
      const qualifiedExploit = qualifiedAgent(personaName, exploitAgentName);
      const personaInput = withPersona(personaName);

      let vulnMetrics: AgentMetrics | null = null;
      if (!shouldSkip(qualifiedVuln)) {
        vulnMetrics = await runVulnAgent(personaInput);
      } else {
        log.info(`Skipping ${qualifiedVuln} (already complete)`);
      }

      const decision = await a.checkExploitationQueue(personaInput, vulnType);

      let exploitMetrics: AgentMetrics | null = null;
      if (decision.shouldExploit) {
        if (!shouldSkip(qualifiedExploit)) {
          exploitMetrics = await runExploitAgent(personaInput);
        } else {
          log.info(`Skipping ${qualifiedExploit} (already complete)`);
        }
      }

      return {
        vulnType,
        vulnAgent: qualifiedVuln,
        exploitAgent: qualifiedExploit,
        vulnMetrics,
        exploitMetrics,
        exploitDecision: {
          shouldExploit: decision.shouldExploit,
          vulnerabilityCount: decision.vulnerabilityCount,
        },
        error: null,
      };
    }

    // Pipeline configs now return run* as activity invokers — input is supplied
    // per persona at scheduling time so the same config runs N times across
    // personas without rebuilding.
    interface PipelineConfigEntry {
      vulnType: VulnType;
      vulnAgent: string;
      exploitAgent: string;
      runVuln: (input: ActivityInput) => Promise<AgentMetrics>;
      runExploit: (input: ActivityInput) => Promise<AgentMetrics>;
    }

    function buildGrayboxPipelineConfigs(): PipelineConfigEntry[] {
      return [
        { vulnType: 'injection', vulnAgent: 'graybox-injection-vuln', exploitAgent: 'graybox-injection-exploit',
          runVuln: a.runGrayboxInjectionVulnAgent, runExploit: a.runGrayboxInjectionExploitAgent },
        { vulnType: 'xss', vulnAgent: 'graybox-xss-vuln', exploitAgent: 'graybox-xss-exploit',
          runVuln: a.runGrayboxXssVulnAgent, runExploit: a.runGrayboxXssExploitAgent },
        { vulnType: 'auth', vulnAgent: 'graybox-auth-vuln', exploitAgent: 'graybox-auth-exploit',
          runVuln: a.runGrayboxAuthVulnAgent, runExploit: a.runGrayboxAuthExploitAgent },
        { vulnType: 'ssrf', vulnAgent: 'graybox-ssrf-vuln', exploitAgent: 'graybox-ssrf-exploit',
          runVuln: a.runGrayboxSsrfVulnAgent, runExploit: a.runGrayboxSsrfExploitAgent },
        { vulnType: 'authz', vulnAgent: 'graybox-authz-vuln', exploitAgent: 'graybox-authz-exploit',
          runVuln: a.runGrayboxAuthzVulnAgent, runExploit: a.runGrayboxAuthzExploitAgent },
      ];
    }

    function buildMobileGrayboxPipelineConfigs(): PipelineConfigEntry[] {
      return [
        { vulnType: 'injection', vulnAgent: 'mobile-injection-vuln', exploitAgent: 'mobile-injection-exploit',
          runVuln: a.runMobileInjectionVulnAgent, runExploit: a.runMobileInjectionExploitAgent },
        { vulnType: 'xss', vulnAgent: 'mobile-xss-vuln', exploitAgent: 'mobile-xss-exploit',
          runVuln: a.runMobileXssVulnAgent, runExploit: a.runMobileXssExploitAgent },
        { vulnType: 'auth', vulnAgent: 'mobile-auth-vuln', exploitAgent: 'mobile-auth-exploit',
          runVuln: a.runMobileAuthVulnAgent, runExploit: a.runMobileAuthExploitAgent },
        { vulnType: 'ssrf', vulnAgent: 'mobile-ssrf-vuln', exploitAgent: 'mobile-ssrf-exploit',
          runVuln: a.runMobileSsrfVulnAgent, runExploit: a.runMobileSsrfExploitAgent },
        { vulnType: 'authz', vulnAgent: 'mobile-authz-vuln', exploitAgent: 'mobile-authz-exploit',
          runVuln: a.runMobileAuthzVulnAgent, runExploit: a.runMobileAuthzExploitAgent },
      ];
    }

    function buildApiGrayboxPipelineConfigs(): PipelineConfigEntry[] {
      return [
        { vulnType: 'injection', vulnAgent: 'api-injection-vuln', exploitAgent: 'api-injection-exploit',
          runVuln: a.runApiInjectionVulnAgent, runExploit: a.runApiInjectionExploitAgent },
        { vulnType: 'xss', vulnAgent: 'api-xss-vuln', exploitAgent: 'api-xss-exploit',
          runVuln: a.runApiXssVulnAgent, runExploit: a.runApiXssExploitAgent },
        { vulnType: 'auth', vulnAgent: 'api-auth-vuln', exploitAgent: 'api-auth-exploit',
          runVuln: a.runApiAuthVulnAgent, runExploit: a.runApiAuthExploitAgent },
        { vulnType: 'ssrf', vulnAgent: 'api-ssrf-vuln', exploitAgent: 'api-ssrf-exploit',
          runVuln: a.runApiSsrfVulnAgent, runExploit: a.runApiSsrfExploitAgent },
        { vulnType: 'authz', vulnAgent: 'api-authz-vuln', exploitAgent: 'api-authz-exploit',
          runVuln: a.runApiAuthzVulnAgent, runExploit: a.runApiAuthzExploitAgent },
      ];
    }

    // Run vuln→exploit pipelines for every (persona × vuln-type) pair in parallel,
    // bounded by max_concurrent_pipelines. Failure of one pair never blocks others.
    async function runPipelinePhase(pipelineConfigs: PipelineConfigEntry[]): Promise<void> {
      state.currentPhase = 'vulnerability-exploitation';
      state.currentAgent = 'pipelines';
      await a.logPhaseTransition(activityInput, 'vulnerability-exploitation', 'start');

      const maxConcurrent = input.pipelineConfig?.max_concurrent_pipelines ?? 5;
      const pipelineThunks: Array<() => Promise<VulnExploitPipelineResult>> = [];

      for (const persona of personas) {
        for (const config of pipelineConfigs) {
          const qualifiedVuln = qualifiedAgent(persona.name, config.vulnAgent);
          const qualifiedExploit = qualifiedAgent(persona.name, config.exploitAgent);
          if (!shouldSkip(qualifiedVuln) || !shouldSkip(qualifiedExploit)) {
            pipelineThunks.push(
              () => runVulnExploitPipeline(
                persona.name,
                config.vulnType, config.vulnAgent, config.exploitAgent,
                config.runVuln, config.runExploit
              )
            );
          } else {
            log.info(`Skipping entire ${config.vulnType} pipeline for ${persona.name} (both agents complete)`);
            state.completedAgents.push(qualifiedVuln, qualifiedExploit);
          }
        }
      }

      const pipelineResults = await runWithConcurrencyLimit(pipelineThunks, maxConcurrent);
      aggregatePipelineResults(pipelineResults);

      state.currentPhase = 'exploitation';
      state.currentAgent = null;
      await a.logPhaseTransition(activityInput, 'vulnerability-exploitation', 'complete');
    }

    log.info(`Personas in this run: ${personas.map((p) => p.name).join(', ')}`);

    if (isApi) {
      log.info('Starting API graybox pipeline mode');
      await runSequentialPhase('discovery', 'api-discovery', a.runApiDiscoveryAgent);
      await runAuthMapperPhase('api-auth-mapper', a.runApiAuthMapperAgent);
      await runPipelinePhase(buildApiGrayboxPipelineConfigs());

    } else if (isMobile) {
      log.info('Starting mobile graybox pipeline mode');
      await runSequentialPhase('discovery', 'mobile-discovery', a.runMobileDiscoveryAgent);
      await runAuthMapperPhase('mobile-auth-mapper', a.runMobileAuthMapperAgent);
      await runPipelinePhase(buildMobileGrayboxPipelineConfigs());

    } else if (isGraybox) {
      log.info('Starting gray-box pipeline mode');
      await runSequentialPhase('discovery', 'discovery', a.runDiscoveryAgent);
      await runAuthMapperPhase('auth-mapper', a.runAuthMapperAgent);
      await a.aggregateAuthMapsActivity(activityInput);
      await runPipelinePhase(buildGrayboxPipelineConfigs());

    } else {
      // DISABLED: whitebox pipeline branch — runtime deprecated. Kept as reference.
      // Uncomment buildPipelineConfigs + the whitebox activity exports to restore.
      // log.info('Starting white-box pipeline mode');
      // // === Phase 1: Pre-Reconnaissance ===
      // await runSequentialPhase('pre-recon', 'pre-recon', a.runPreReconAgent);
      //
      // // === Phase 2: Reconnaissance ===
      // await runSequentialPhase('recon', 'recon', a.runReconAgent);
      //
      // // === Phases 3-4: Vulnerability Analysis + Exploitation (Pipelined) ===
      // await runPipelinePhase(buildPipelineConfigs());
      throw new Error(
        'Whitebox pipeline is disabled. Set pipeline.mode to "graybox" (or use target mobile/api) in your config.'
      );
    }

    // === Phase 5: Reporting ===
    if (isApi) {
      const reportAgent = 'api-report';
      if (!shouldSkip(reportAgent)) {
        state.currentPhase = 'reporting';
        state.currentAgent = reportAgent;
        await a.logPhaseTransition(activityInput, 'reporting', 'start');

        await a.assembleReportActivity(activityInput);
        state.agentMetrics[reportAgent] = await a.runApiReportAgent(activityInput);
        state.completedAgents.push(reportAgent);

        await a.injectReportMetadataActivity(activityInput);
        await a.logPhaseTransition(activityInput, 'reporting', 'complete');
      } else {
        log.info('Skipping api-report (already complete)');
        state.completedAgents.push(reportAgent);
      }
    } else if (isMobile) {
      const reportAgent = 'mobile-report';
      if (!shouldSkip(reportAgent)) {
        state.currentPhase = 'reporting';
        state.currentAgent = reportAgent;
        await a.logPhaseTransition(activityInput, 'reporting', 'start');

        await a.assembleReportActivity(activityInput);
        state.agentMetrics[reportAgent] = await a.runMobileReportAgent(activityInput);
        state.completedAgents.push(reportAgent);

        await a.injectReportMetadataActivity(activityInput);
        await a.logPhaseTransition(activityInput, 'reporting', 'complete');
      } else {
        log.info('Skipping mobile-report (already complete)');
        state.completedAgents.push(reportAgent);
      }
    } else if (isGraybox) {
      const reportAgent = 'graybox-report';
      if (!shouldSkip(reportAgent)) {
        state.currentPhase = 'reporting';
        state.currentAgent = reportAgent;
        await a.logPhaseTransition(activityInput, 'reporting', 'start');

        // Assemble graybox deliverables into the pre-report, then run report agent
        await a.assembleReportActivity(activityInput);
        state.agentMetrics[reportAgent] = await a.runGrayboxReportAgent(activityInput);
        state.completedAgents.push(reportAgent);

        await a.injectReportMetadataActivity(activityInput);
        await a.logPhaseTransition(activityInput, 'reporting', 'complete');
      } else {
        log.info('Skipping graybox-report (already complete)');
        state.completedAgents.push(reportAgent);
      }
    } else {
      // DISABLED: whitebox report branch — runtime deprecated. Kept as reference.
      // if (!shouldSkip('report')) {
      //   state.currentPhase = 'reporting';
      //   state.currentAgent = 'report';
      //   await a.logPhaseTransition(activityInput, 'reporting', 'start');
      //
      //   // Assemble whitebox exploitation evidence, then run report agent
      //   await a.assembleReportActivity(activityInput);
      //   state.agentMetrics['report'] = await a.runReportAgent(activityInput);
      //   state.completedAgents.push('report');
      //
      //   await a.injectReportMetadataActivity(activityInput);
      //   await a.logPhaseTransition(activityInput, 'reporting', 'complete');
      // } else {
      //   log.info('Skipping report (already complete)');
      //   state.completedAgents.push('report');
      // }
      throw new Error(
        'Whitebox reporting branch is disabled. Set pipeline.mode to "graybox" (or use target mobile/api) in your config.'
      );
    }

    state.status = 'completed';
    state.currentPhase = null;
    state.currentAgent = null;
    state.summary = computeSummary(state);

    // Log workflow completion summary
    await a.logWorkflowComplete(activityInput, toWorkflowSummary(state, 'completed'));

    return state;
  } catch (error) {
    state.status = 'failed';
    state.failedAgent = state.currentAgent;
    state.error = formatWorkflowError(error, state.currentPhase, state.currentAgent);
    state.summary = computeSummary(state);

    // Log workflow failure summary
    await a.logWorkflowComplete(activityInput, toWorkflowSummary(state, 'failed'));

    throw error;
  }
}
