import { defineQuery } from '@temporalio/workflow';

export type { AgentMetrics } from '../types/metrics.js';
import type { AgentMetrics } from '../types/metrics.js';
import type { PipelineConfig, MobilePlatform } from '../types/config.js';

// Minimal persona descriptor for workflow scheduling. Credentials live in the
// config file (loaded inside activities), not here — workflows must be pure.
export interface PersonaDescriptor {
  name: string;
  role?: string;
}

export interface PipelineInput {
  webUrl: string;
  // Read-only project documentation folder (./repos/<name>/). Injected into
  // prompts as {{REPO_PATH}} so agents can read docs/, schemas/, api/, auth/.
  // For mobile/api modes this may equal workspacePath (no separate docs folder).
  repoPath: string;
  // Agent working directory (./audit-logs/<sessionId>/). Deliverables are
  // written under {workspacePath}/deliverables/. This is distinct from repoPath
  // so input docs never mix with generated output.
  workspacePath: string;
  configPath?: string;
  outputPath?: string;
  pipelineTestingMode?: boolean;
  pipelineConfig?: PipelineConfig;
  workflowId?: string; // Used for audit correlation
  sessionId?: string; // Workspace directory name (distinct from workflowId for named workspaces)
  resumeFromWorkspace?: string; // Workspace name to resume from
  terminatedWorkflows?: string[]; // Workflows terminated during resume
  // Personas to test in this run. Always non-empty (auto-migrate guarantees
  // at least one persona; defaults to [{ name: 'default' }] for legacy configs
  // that didn't declare authentication at all).
  personas: PersonaDescriptor[];
  // Mobile-specific fields (set when pipeline.target is 'mobile')
  appPath?: string;
  platform?: MobilePlatform;
  deviceId?: string;
  appiumUrl?: string;
  backendApiUrl?: string;
  bundleId?: string;
}

export interface ResumeState {
  workspaceName: string;
  originalUrl: string;
  completedAgents: string[];
  checkpointHash: string;
  originalWorkflowId: string;
}

export interface PipelineSummary {
  totalCostUsd: number;
  totalDurationMs: number; // Wall-clock time (end - start)
  totalTurns: number;
  agentCount: number;
}

export interface PipelineState {
  status: 'running' | 'completed' | 'failed';
  currentPhase: string | null;
  currentAgent: string | null;
  completedAgents: string[];
  failedAgent: string | null;
  error: string | null;
  startTime: number;
  agentMetrics: Record<string, AgentMetrics>;
  summary: PipelineSummary | null;
}

// Extended state returned by getProgress query (includes computed fields)
export interface PipelineProgress extends PipelineState {
  workflowId: string;
  elapsedMs: number;
}

// Result from a single vuln→exploit pipeline
export interface VulnExploitPipelineResult {
  vulnType: string;
  vulnAgent: string;
  exploitAgent: string;
  vulnMetrics: AgentMetrics | null;
  exploitMetrics: AgentMetrics | null;
  exploitDecision: {
    shouldExploit: boolean;
    vulnerabilityCount: number;
  } | null;
  error: string | null;
}

export const getProgress = defineQuery<PipelineProgress>('getProgress');
