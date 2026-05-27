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
export const WHITEBOX_AGENTS = [
  'pre-recon',
  'recon',
  'injection-vuln',
  'xss-vuln',
  'auth-vuln',
  'ssrf-vuln',
  'authz-vuln',
  'injection-exploit',
  'xss-exploit',
  'auth-exploit',
  'ssrf-exploit',
  'authz-exploit',
  'report',
] as const;

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

// Network graybox tier — 15 agents instead of the usual 13. Adds an explicit
// `network-enumeration` phase between discovery and auth-mapper (the per-service
// enumeration seam is semantically distinct from host/port discovery), and a
// sequential `network-postex-sim` phase after the 5× exploit fan-out for
// lateral-movement planning and post-exploit simulation. Note the
// protocols-vuln → relay-exploit pairing — the natural "exploit" for protocol
// weaknesses (LLMNR/NBT-NS/IPv6) is NTLM relay via Responder/mitm6/ntlmrelayx,
// so the exploit slot is named for the technique, not the vuln axis.
export const NETWORK_GRAYBOX_AGENTS = [
  'network-discovery',
  'network-enumeration',
  'network-auth-mapper',
  'network-services-vuln',
  'network-ad-vuln',
  'network-protocols-vuln',
  'network-creds-vuln',
  'network-configs-vuln',
  'network-services-exploit',
  'network-ad-exploit',
  'network-relay-exploit',
  'network-creds-exploit',
  'network-configs-exploit',
  'network-postex-sim',
  'network-report',
] as const;

export const ALL_AGENTS = [
  ...WHITEBOX_AGENTS,
  ...GRAYBOX_AGENTS,
  ...MOBILE_GRAYBOX_AGENTS,
  ...API_GRAYBOX_AGENTS,
  ...NETWORK_GRAYBOX_AGENTS,
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

// Network agents have no browser/device driver — Bash + native CLI tools only.
// Semantically distinct from `api-only` even though the downstream treatment
// (no playwright/appium MCP) is identical.
export type NetworkAgent = 'network-only';

export type AppiumAgent =
  | 'appium-agent1'
  | 'appium-agent2'
  | 'appium-agent3'
  | 'appium-agent4'
  | 'appium-agent5';

import type { ActivityLogger } from './activity-logger.js';

export type AgentValidator = (
  sourceDir: string,
  logger: ActivityLogger,
  personaName?: string
) => Promise<boolean>;

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
 *
 * Web / mobile / API tiers share the OWASP-derived axes
 * (injection/xss/auth/ssrf/authz). Network tier uses its own
 * domain-native axes (services/ad/protocols/creds/configs) to match
 * how network findings actually cluster — Kerberoasting does not fit
 * "injection" or "xss" without distortion. The two sets never collide
 * (a single workflow run is bound to one target/tier).
 */
export type VulnType =
  | 'injection' | 'xss' | 'auth' | 'ssrf' | 'authz'
  | 'services' | 'ad' | 'protocols' | 'creds' | 'configs';

export type WebVulnType = 'injection' | 'xss' | 'auth' | 'ssrf' | 'authz';
export type NetworkVulnType = 'services' | 'ad' | 'protocols' | 'creds' | 'configs';

/**
 * Decision returned by queue validation for exploitation phase.
 */
export interface ExploitationDecision {
  shouldExploit: boolean;
  shouldRetry: boolean;
  vulnerabilityCount: number;
  vulnType: VulnType;
}
