// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Agent type definitions
 */

/**
 * List of all agents in execution order.
 * Used for iteration during resume state checking.
 */
// DISABLED: whitebox runtime deprecated. Kept as reference — uncomment to restore.
// export const WHITEBOX_AGENTS = [
//   'pre-recon',
//   'recon',
//   'injection-vuln',
//   'xss-vuln',
//   'auth-vuln',
//   'ssrf-vuln',
//   'authz-vuln',
//   'injection-exploit',
//   'xss-exploit',
//   'auth-exploit',
//   'ssrf-exploit',
//   'authz-exploit',
//   'report',
// ] as const;
export const WHITEBOX_AGENTS = [] as const;

export const GRAYBOX_AGENTS = [
  'discovery',
  'auth-mapper',
  'graybox-injection-vuln',
  'graybox-xss-vuln',
  'graybox-auth-vuln',
  'graybox-ssrf-vuln',
  'graybox-authz-vuln',
  'graybox-injection-exploit',
  'graybox-xss-exploit',
  'graybox-auth-exploit',
  'graybox-ssrf-exploit',
  'graybox-authz-exploit',
  'graybox-report',
] as const;

export const MOBILE_GRAYBOX_AGENTS = [
  'mobile-discovery',
  'mobile-auth-mapper',
  'mobile-injection-vuln',
  'mobile-xss-vuln',
  'mobile-auth-vuln',
  'mobile-ssrf-vuln',
  'mobile-authz-vuln',
  'mobile-injection-exploit',
  'mobile-xss-exploit',
  'mobile-auth-exploit',
  'mobile-ssrf-exploit',
  'mobile-authz-exploit',
  'mobile-report',
] as const;

export const API_GRAYBOX_AGENTS = [
  'api-discovery',
  'api-auth-mapper',
  'api-injection-vuln',
  'api-xss-vuln',
  'api-auth-vuln',
  'api-ssrf-vuln',
  'api-authz-vuln',
  'api-injection-exploit',
  'api-xss-exploit',
  'api-auth-exploit',
  'api-ssrf-exploit',
  'api-authz-exploit',
  'api-report',
] as const;

export const ALL_AGENTS = [
  ...WHITEBOX_AGENTS,
  ...GRAYBOX_AGENTS,
  ...MOBILE_GRAYBOX_AGENTS,
  ...API_GRAYBOX_AGENTS,
] as const;

/**
 * Agent name type derived from ALL_AGENTS.
 * This ensures type safety and prevents drift between type and array.
 */
export type AgentName = typeof ALL_AGENTS[number];

export type PlaywrightAgent =
  | 'playwright-agent1'
  | 'playwright-agent2'
  | 'playwright-agent3'
  | 'playwright-agent4'
  | 'playwright-agent5';

export type ApiAgent = 'api-only';

export type AppiumAgent =
  | 'appium-agent1'
  | 'appium-agent2'
  | 'appium-agent3'
  | 'appium-agent4'
  | 'appium-agent5';

import type { ActivityLogger } from './activity-logger.js';

export type AgentValidator = (sourceDir: string, logger: ActivityLogger) => Promise<boolean>;

export type AgentStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'rolled-back';

export interface AgentDefinition {
  name: AgentName;
  displayName: string;
  prerequisites: AgentName[];
  promptTemplate: string;
  deliverableFilename: string;
  modelTier?: 'small' | 'medium' | 'large';
}

/**
 * Vulnerability types supported by the pipeline.
 */
export type VulnType = 'injection' | 'xss' | 'auth' | 'ssrf' | 'authz';

/**
 * Decision returned by queue validation for exploitation phase.
 */
export interface ExploitationDecision {
  shouldExploit: boolean;
  shouldRetry: boolean;
  vulnerabilityCount: number;
  vulnType: VulnType;
}
