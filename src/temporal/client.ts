#!/usr/bin/env node
// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Temporal client for starting Shannon pentest pipeline workflows.
 *
 * Starts a workflow and optionally waits for completion with progress polling.
 *
 * Usage:
 *   npm run temporal:start -- <webUrl> --repo <path> [options]
 *   # or
 *   node dist/temporal/client.js <webUrl> --repo <path> [options]
 *
 * Options:
 *   --repo <path>         Documentation folder for the target (required, all modes)
 *   --config <path>       Configuration file path
 *   --output <path>       Output directory for audit logs
 *   --pipeline-testing    Use minimal prompts for fast testing
 *   --workflow-id <id>    Custom workflow ID (default: shannon-<timestamp>)
 *   --wait                Wait for workflow completion with progress polling
 *
 * Environment:
 *   TEMPORAL_ADDRESS - Temporal server address (default: localhost:7233)
 */

import { Connection, Client, WorkflowNotFoundError, type WorkflowHandle } from '@temporalio/client';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { displaySplashScreen } from '../splash-screen.js';
import { sanitizeHostname } from '../audit/utils.js';
import { readJson, fileExists } from '../utils/file-io.js';
import path from 'path';
import { parseConfig, distributeConfig } from '../config-parser.js';
import type { PipelineConfig, MobileConfig } from '../types/config.js';
import type { PersonaDescriptor } from './shared.js';
// Import types only - these don't pull in workflow runtime code
import type { PipelineInput, PipelineState, PipelineProgress } from './shared.js';

/**
 * Session.json structure for resume validation
 */
interface SessionJson {
  session: {
    id: string;
    webUrl: string;
    originalWorkflowId?: string;
    resumeAttempts?: Array<{ workflowId: string }>;
  };
  metrics: {
    total_cost_usd: number;
  };
}

dotenv.config();

// Query name must match the one defined in workflows.ts
const PROGRESS_QUERY = 'getProgress';

/**
 * Terminate any running workflows associated with a workspace.
 * Returns the list of terminated workflow IDs.
 */
async function terminateExistingWorkflows(
  client: Client,
  workspaceName: string
): Promise<string[]> {
  const sessionPath = path.join('./audit-logs', workspaceName, 'session.json');

  if (!(await fileExists(sessionPath))) {
    throw new Error(
      `Workspace not found: ${workspaceName}\n` +
      `Expected path: ${sessionPath}`
    );
  }

  const session = await readJson<SessionJson>(sessionPath);

  // Collect all workflow IDs associated with this workspace
  const workflowIds = [
    session.session.originalWorkflowId || session.session.id,
    ...(session.session.resumeAttempts?.map((r) => r.workflowId) || []),
  ].filter((id): id is string => id != null);

  const terminated: string[] = [];

  for (const wfId of workflowIds) {
    try {
      const handle = client.workflow.getHandle(wfId);
      const description = await handle.describe();

      if (description.status.name === 'RUNNING') {
        console.log(`Terminating running workflow: ${wfId}`);
        await handle.terminate('Superseded by resume workflow');
        terminated.push(wfId);
        console.log(`Terminated: ${wfId}`);
      } else {
        console.log(`Workflow already ${description.status.name}: ${wfId}`);
      }
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        console.log(`Workflow not found (already cleaned up): ${wfId}`);
      } else {
        console.log(`Failed to terminate ${wfId}: ${error}`);
        // Continue anyway - don't block resume on termination failure
      }
    }
  }

  return terminated;
}

/**
 * Validate workspace name: alphanumeric, hyphens, underscores, 1-128 chars,
 * must start with alphanumeric.
 */
function isValidWorkspaceName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name);
}

function showUsage(): void {
  console.log('\nShannon Temporal Client');
  console.log('Start a pentest pipeline workflow\n');
  console.log('Usage:');
  console.log(
    '  node dist/temporal/client.js <webUrl> --repo <path> [options]\n'
  );
  console.log('Options:');
  console.log('  --repo <path>         Documentation folder for target (required, all modes)');
  console.log('  --config <path>       Configuration file path');
  console.log('  --output <path>       Output directory for audit logs');
  console.log('  --pipeline-testing    Use minimal prompts for fast testing');
  console.log('  --workspace <name>    Resume from existing workspace');
  console.log(
    '  --workflow-id <id>    Custom workflow ID (default: shannon-<timestamp>)'
  );
  console.log('  --wait                Wait for workflow completion with progress polling\n');
  console.log('Examples:');
  console.log('  node dist/temporal/client.js https://example.com --repo /repos/my-target');
  console.log(
    '  node dist/temporal/client.js https://example.com --repo /repos/my-target --config config.yaml\n'
  );
}

// === CLI Argument Parsing ===

interface CliArgs {
  webUrl: string;
  repoPath: string;
  workspacePath?: string;
  configPath?: string;
  outputPath?: string;
  displayOutputPath?: string;
  pipelineTestingMode: boolean;
  customWorkflowId?: string;
  waitForCompletion: boolean;
  resumeFromWorkspace?: string;
  isMobileTarget?: boolean;
  isApiTarget?: boolean;
  app?: string;
  device?: string;
  apk?: string;
}

async function parseCliArgs(argv: string[]): Promise<CliArgs> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    showUsage();
    process.exit(0);
  }

  let webUrl: string | undefined;
  let repoPath: string | undefined;
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let displayOutputPath: string | undefined;
  let pipelineTestingMode = false;
  let customWorkflowId: string | undefined;
  let waitForCompletion = false;
  let resumeFromWorkspace: string | undefined;
  let app: string | undefined;
  let device: string | undefined;
  let apk: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        configPath = nextArg;
        i++;
      }
    } else if (arg === '--repo') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        repoPath = nextArg;
        i++;
      }
    } else if (arg === '--output') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        outputPath = nextArg;
        i++;
      }
    } else if (arg === '--display-output') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        displayOutputPath = nextArg;
        i++;
      }
    } else if (arg === '--workflow-id') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        customWorkflowId = nextArg;
        i++;
      }
    } else if (arg === '--pipeline-testing') {
      pipelineTestingMode = true;
    } else if (arg === '--workspace') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        resumeFromWorkspace = nextArg;
        i++;
      }
    } else if (arg === '--wait') {
      waitForCompletion = true;
    } else if (arg === '--app') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        app = nextArg;
        i++;
      }
    } else if (arg === '--device') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        device = nextArg;
        i++;
      }
    } else if (arg === '--apk') {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        apk = nextArg;
        i++;
      }
    } else if (arg && !arg.startsWith('-')) {
      if (!webUrl) {
        webUrl = arg;
      }
    }
  }

  const isMobileTarget = app != null || (configPath ? await detectMobileTarget(configPath) : false);
  const isApiTarget = configPath ? await detectApiTarget(configPath) : false;

  if (!repoPath) {
    console.log('Error: --repo is required (documentation folder for the target)');
    showUsage();
    process.exit(1);
  }

  if (!isMobileTarget && !webUrl) {
    console.log('Error: webUrl is required for web/api target mode');
    showUsage();
    process.exit(1);
  }

  return {
    webUrl: webUrl || '',
    repoPath: repoPath || '',
    pipelineTestingMode,
    waitForCompletion,
    ...(isMobileTarget && { isMobileTarget }),
    ...(isApiTarget && { isApiTarget }),
    ...(configPath && { configPath }),
    ...(outputPath && { outputPath }),
    ...(displayOutputPath && { displayOutputPath }),
    ...(customWorkflowId && { customWorkflowId }),
    ...(resumeFromWorkspace && { resumeFromWorkspace }),
    ...(app && { app }),
    ...(device && { device }),
    ...(apk && { apk }),
  };
}

// === Workspace Resolution ===

interface WorkspaceResolution {
  workflowId: string;
  sessionId: string;
  isResume: boolean;
  terminatedWorkflows: string[];
}

async function resolveWorkspace(
  client: Client,
  args: CliArgs
): Promise<WorkspaceResolution> {
  if (!args.resumeFromWorkspace) {
    const prefix = args.isMobileTarget && args.app
      ? args.app.replace(/[^a-zA-Z0-9-]/g, '-')
      : sanitizeHostname(args.webUrl);
    const workflowId = args.customWorkflowId || `${prefix}_shannon-${Date.now()}`;
    return {
      workflowId,
      sessionId: workflowId,
      isResume: false,
      terminatedWorkflows: [],
    };
  }

  const workspace = args.resumeFromWorkspace;
  const sessionPath = path.join('./audit-logs', workspace, 'session.json');
  const workspaceExists = await fileExists(sessionPath);

  if (workspaceExists) {
    console.log('=== RESUME MODE ===');
    console.log(`Workspace: ${workspace}\n`);

    // 1. Terminate any running workflows from previous attempts
    const terminatedWorkflows = await terminateExistingWorkflows(client, workspace);
    if (terminatedWorkflows.length > 0) {
      console.log(`Terminated ${terminatedWorkflows.length} previous workflow(s)\n`);
    }

    // 2. Validate target matches the workspace (skip for mobile — no URL to compare)
    if (!args.isMobileTarget) {
      const session = await readJson<SessionJson>(sessionPath);
      if (session.session.webUrl !== args.webUrl) {
        console.error('ERROR: URL mismatch with workspace');
        console.error(`  Workspace URL: ${session.session.webUrl}`);
        console.error(`  Provided URL:  ${args.webUrl}`);
        process.exit(1);
      }
    }

    // 3. Generate a new workflow ID scoped to this resume attempt
    // 4. Return resolution with isResume=true so downstream uses resume logic
    return {
      workflowId: `${workspace}_resume_${Date.now()}`,
      sessionId: workspace,
      isResume: true,
      terminatedWorkflows,
    };
  }

  if (!isValidWorkspaceName(workspace)) {
    console.error(`ERROR: Invalid workspace name: "${workspace}"`);
    console.error('  Must be 1-128 characters, alphanumeric/hyphens/underscores, starting with alphanumeric');
    process.exit(1);
  }

  console.log('=== NEW NAMED WORKSPACE ===');
  console.log(`Workspace: ${workspace}\n`);

  return {
    workflowId: `${workspace}_shannon-${Date.now()}`,
    sessionId: workspace,
    isResume: false,
    terminatedWorkflows: [],
  };
}

// === Pipeline Input Construction ===

/** Peek at config to detect mobile target before full validation. */
async function detectMobileTarget(configPath: string): Promise<boolean> {
  try {
    const config = await parseConfig(configPath);
    return config.pipeline?.target === 'mobile';
  } catch {
    return false;
  }
}

/** Peek at config to detect API target before full validation. */
async function detectApiTarget(configPath: string): Promise<boolean> {
  try {
    const config = await parseConfig(configPath);
    return config.pipeline?.target === 'api';
  } catch {
    return false;
  }
}

interface LoadedConfig {
  pipelineConfig: PipelineConfig;
  mobile: MobileConfig | null;
  personas: PersonaDescriptor[];
}

async function loadPipelineConfig(configPath: string | undefined): Promise<LoadedConfig> {
  if (!configPath) {
    return { pipelineConfig: {}, mobile: null, personas: [{ name: 'default' }] };
  }
  try {
    const config = await parseConfig(configPath);
    const raw = config.pipeline;
    const pipelineConfig: PipelineConfig = {};

    if (raw) {
      // FAILSAFE_SCHEMA parses all YAML values as strings — coerce to number
      if (raw.retry_preset !== undefined) {
        pipelineConfig.retry_preset = raw.retry_preset;
      }
      if (raw.max_concurrent_pipelines !== undefined) {
        pipelineConfig.max_concurrent_pipelines = Number(raw.max_concurrent_pipelines);
      }
      if (raw.mode !== undefined) {
        pipelineConfig.mode = raw.mode;
      } else {
        pipelineConfig.mode = 'graybox';
      }
      if (raw.target !== undefined) {
        pipelineConfig.target = raw.target;
      }
    }

    // Extract persona descriptors via distributeConfig (auto-migrates legacy
    // single-credential configs into a single 'default' persona).
    const distributed = distributeConfig(config);
    const personas: PersonaDescriptor[] = distributed.authentication
      ? distributed.authentication.personas.map((p) => ({
          name: p.name,
          ...(p.role && { role: p.role }),
        }))
      : [{ name: 'default' }];

    return { pipelineConfig, mobile: config.mobile || null, personas };
  } catch (error) {
    console.warn(`Warning: failed to load pipeline config: ${error instanceof Error ? error.message : error}`);
    return { pipelineConfig: {}, mobile: null, personas: [{ name: 'default' }] };
  }
}

function buildPipelineInput(
  args: CliArgs, workspace: WorkspaceResolution, loaded: LoadedConfig
): PipelineInput {
  const { pipelineConfig, mobile, personas } = loaded;
  console.log(`Pipeline config: mode=${pipelineConfig.mode}, target=${pipelineConfig.target}`);
  console.log(`Personas: ${personas.map((p) => p.name).join(', ')}`);

  const workspacePath = args.workspacePath!;

  return {
    webUrl: args.webUrl || args.app || mobile?.backend_api_url || '',
    repoPath: args.repoPath,
    workspacePath,
    personas,
    workflowId: workspace.workflowId,
    sessionId: workspace.sessionId,
    ...(args.configPath && { configPath: args.configPath }),
    ...(args.outputPath && { outputPath: args.outputPath }),
    ...(args.pipelineTestingMode && { pipelineTestingMode: args.pipelineTestingMode }),
    ...(workspace.isResume && args.resumeFromWorkspace && { resumeFromWorkspace: args.resumeFromWorkspace }),
    ...(workspace.terminatedWorkflows.length > 0 && { terminatedWorkflows: workspace.terminatedWorkflows }),
    ...(Object.keys(pipelineConfig).length > 0 && { pipelineConfig }),
    // Mobile-specific fields: CLI args override config values
    ...(args.app && { bundleId: args.app }),
    ...(args.device && { deviceId: args.device }),
    ...(args.apk && { appPath: args.apk }),
    ...(mobile && {
      ...(!args.apk && mobile.app_path && { appPath: mobile.app_path }),
      platform: mobile.platform,
      ...(!args.device && mobile.device_id && { deviceId: mobile.device_id }),
      ...(mobile.appium_url && { appiumUrl: mobile.appium_url }),
      ...(mobile.backend_api_url && { backendApiUrl: mobile.backend_api_url }),
      ...(!args.app && mobile.bundle_id && { bundleId: mobile.bundle_id }),
    }),
  };
}

// === Display Helpers ===

function displayWorkflowInfo(args: CliArgs, workspace: WorkspaceResolution): void {
  console.log(`✓ Workflow started: ${workspace.workflowId}`);
  if (workspace.isResume) {
    console.log(`  (Resuming workspace: ${workspace.sessionId})`);
  }
  console.log();
  if (args.isMobileTarget) {
    console.log(`  App:        ${args.app || '(from config)'}`);
    console.log(`  Device:     ${args.device || '(from config)'}`);
    if (args.apk) {
      console.log(`  APK:        ${args.apk}`);
    }
  } else if (args.isApiTarget) {
    console.log(`  API:        ${args.webUrl}`);
    console.log(`  Mode:       API-only (no browser/mobile)`);
  } else {
    console.log(`  Target:     ${args.webUrl}`);
    console.log(`  Repository: ${args.repoPath}`);
  }
  console.log(`  Workspace:  ${workspace.sessionId}`);
  if (args.configPath) {
    console.log(`  Config:     ${args.configPath}`);
  }
  if (args.displayOutputPath) {
    console.log(`  Output:     ${args.displayOutputPath}`);
  }
  if (args.pipelineTestingMode) {
    console.log(`  Mode:       Pipeline Testing`);
  }
  console.log();
}

function displayMonitoringInfo(args: CliArgs, workspace: WorkspaceResolution): void {
  const effectiveDisplayPath = args.displayOutputPath || args.outputPath || './audit-logs';
  const outputDir = `${effectiveDisplayPath}/${workspace.sessionId}`;

  console.log('Monitor progress:');
  console.log(`  Web UI:  http://localhost:8233/namespaces/default/workflows/${workspace.workflowId}`);
  console.log(`  Logs:    ./shannon logs ID=${workspace.workflowId}`);
  console.log();
  console.log('Output:');
  console.log(`  Reports: ${outputDir}`);
  console.log();
}

// === Workflow Result Handling ===

async function waitForWorkflowResult(
  handle: WorkflowHandle<(input: PipelineInput) => Promise<PipelineState>>,
  workspace: WorkspaceResolution
): Promise<void> {
  const progressInterval = setInterval(async () => {
    try {
      const progress = await handle.query<PipelineProgress>(PROGRESS_QUERY);
      const elapsed = Math.floor(progress.elapsedMs / 1000);
      console.log(
        `[${elapsed}s] Phase: ${progress.currentPhase || 'unknown'} | Agent: ${progress.currentAgent || 'none'} | Completed: ${progress.completedAgents.length}/13`
      );
    } catch {
      // Workflow may have completed
    }
  }, 30000);

  try {
    // 1. Block until workflow completes
    const result = await handle.result();
    clearInterval(progressInterval);

    // 2. Display run metrics
    console.log('\nPipeline completed successfully!');
    if (result.summary) {
      console.log(`Duration: ${Math.floor(result.summary.totalDurationMs / 1000)}s`);
      console.log(`Agents completed: ${result.summary.agentCount}`);
      console.log(`Total turns: ${result.summary.totalTurns}`);
      console.log(`Run cost: $${result.summary.totalCostUsd.toFixed(4)}`);

      // 3. Show cumulative cost across all resume attempts
      if (workspace.isResume) {
        try {
          const session = await readJson<SessionJson>(
            path.join('./audit-logs', workspace.sessionId, 'session.json')
          );
          console.log(`Cumulative cost: $${session.metrics.total_cost_usd.toFixed(4)}`);
        } catch {
          // Non-fatal, skip cumulative cost display
        }
      }
    }
  } catch (error) {
    clearInterval(progressInterval);
    console.error('\nPipeline failed:', error);
    process.exit(1);
  }
}

// === Main Entry Point ===

async function startPipeline(): Promise<void> {
  // 1. Parse CLI args and display splash
  const args = await parseCliArgs(process.argv.slice(2));
  await displaySplashScreen();

  // 2. Connect to Temporal server
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  console.log(`Connecting to Temporal at ${address}...`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection });

  try {
    // 3. Load config, resolve workspace, and build pipeline input
    const loaded = await loadPipelineConfig(args.configPath);

    const workspace = await resolveWorkspace(client, args);

    const workspacePath = path.resolve('./audit-logs', workspace.sessionId);
    await fs.mkdir(path.join(workspacePath, 'deliverables'), { recursive: true });
    args.workspacePath = workspacePath;
    console.log(`Using workspace: ${workspacePath}`);
    console.log(`Using docs:      ${args.repoPath}`);

    const input = buildPipelineInput(args, workspace, loaded);

    // 4. Start the Temporal workflow
    console.log(`DEBUG input.pipelineConfig: ${JSON.stringify(input.pipelineConfig)}`);
    console.log(`DEBUG input.bundleId: ${input.bundleId}, input.platform: ${input.platform}`);
    const handle = await client.workflow.start<(input: PipelineInput) => Promise<PipelineState>>(
      'pentestPipelineWorkflow',
      {
        taskQueue: 'shannon-pipeline',
        workflowId: workspace.workflowId,
        args: [input],
      }
    );

    // 5. Display info and optionally wait for completion
    displayWorkflowInfo(args, workspace);

    if (args.waitForCompletion) {
      await waitForWorkflowResult(handle, workspace);
    } else {
      displayMonitoringInfo(args, workspace);
    }
  } finally {
    await connection.close();
  }
}

startPipeline().catch((err) => {
  console.error('Client error:', err);
  process.exit(1);
});
