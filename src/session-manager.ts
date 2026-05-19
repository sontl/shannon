// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { path, fs } from 'zx';
import { validateQueueAndDeliverable } from './services/queue-validation.js';
import type { AgentName, AgentDefinition, PlaywrightAgent, AppiumAgent, ApiAgent, AgentValidator, VulnType } from './types/index.js';
import type { ActivityLogger } from './types/activity-logger.js';

// Agent definitions according to PRD
// NOTE: deliverableFilename values must match mcp-server/src/types/deliverables.ts:DELIVERABLE_FILENAMES
export const AGENTS: Readonly<Record<AgentName, AgentDefinition>> = Object.freeze({
  // === Whitebox Agents (source-code analysis at {{SRC_PATH}}) ===
  'pre-recon': {
    name: 'pre-recon',
    displayName: 'Pre-recon agent',
    prerequisites: [],
    promptTemplate: 'pre-recon-code',
    deliverableFilename: 'code_analysis_deliverable.md',
    modelTier: 'large',
  },
  'recon': {
    name: 'recon',
    displayName: 'Recon agent',
    prerequisites: ['pre-recon'],
    promptTemplate: 'recon',
    deliverableFilename: 'recon_deliverable.md',
  },
  'injection-vuln': {
    name: 'injection-vuln',
    displayName: 'Injection vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'xss-vuln': {
    name: 'xss-vuln',
    displayName: 'XSS vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-xss',
    deliverableFilename: 'xss_analysis_deliverable.md',
  },
  'auth-vuln': {
    name: 'auth-vuln',
    displayName: 'Auth vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-auth',
    deliverableFilename: 'auth_analysis_deliverable.md',
  },
  'ssrf-vuln': {
    name: 'ssrf-vuln',
    displayName: 'SSRF vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-ssrf',
    deliverableFilename: 'ssrf_analysis_deliverable.md',
  },
  'authz-vuln': {
    name: 'authz-vuln',
    displayName: 'Authz vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-authz',
    deliverableFilename: 'authz_analysis_deliverable.md',
  },
  'injection-exploit': {
    name: 'injection-exploit',
    displayName: 'Injection exploit agent',
    prerequisites: ['injection-vuln'],
    promptTemplate: 'exploit-injection',
    deliverableFilename: 'injection_exploitation_evidence.md',
  },
  'xss-exploit': {
    name: 'xss-exploit',
    displayName: 'XSS exploit agent',
    prerequisites: ['xss-vuln'],
    promptTemplate: 'exploit-xss',
    deliverableFilename: 'xss_exploitation_evidence.md',
  },
  'auth-exploit': {
    name: 'auth-exploit',
    displayName: 'Auth exploit agent',
    prerequisites: ['auth-vuln'],
    promptTemplate: 'exploit-auth',
    deliverableFilename: 'auth_exploitation_evidence.md',
  },
  'ssrf-exploit': {
    name: 'ssrf-exploit',
    displayName: 'SSRF exploit agent',
    prerequisites: ['ssrf-vuln'],
    promptTemplate: 'exploit-ssrf',
    deliverableFilename: 'ssrf_exploitation_evidence.md',
  },
  'authz-exploit': {
    name: 'authz-exploit',
    displayName: 'Authz exploit agent',
    prerequisites: ['authz-vuln'],
    promptTemplate: 'exploit-authz',
    deliverableFilename: 'authz_exploitation_evidence.md',
  },
  'report': {
    name: 'report',
    displayName: 'Report agent',
    prerequisites: ['injection-exploit', 'xss-exploit', 'auth-exploit', 'ssrf-exploit', 'authz-exploit'],
    promptTemplate: 'report-executive',
    deliverableFilename: 'final_report.md',
    modelTier: 'small',
  },
  'discovery': {
    name: 'discovery',
    displayName: 'Gray-box Discovery Agent',
    prerequisites: [],
    promptTemplate: 'graybox/discovery',
    deliverableFilename: 'graybox_discovery.md',
    modelTier: 'large',
  },
  'auth-mapper': {
    name: 'auth-mapper',
    displayName: 'Gray-box Auth Mapper Agent',
    prerequisites: ['discovery'],
    promptTemplate: 'graybox/auth-mapper',
    deliverableFilename: 'graybox_auth_map.md',
  },
  'graybox-injection-vuln': {
    name: 'graybox-injection-vuln',
    displayName: 'Gray-box Injection Vuln Agent',
    prerequisites: ['auth-mapper'],
    promptTemplate: 'graybox/vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'graybox-xss-vuln': {
    name: 'graybox-xss-vuln',
    displayName: 'Gray-box XSS Vuln Agent',
    prerequisites: ['auth-mapper'],
    promptTemplate: 'graybox/vuln-xss',
    deliverableFilename: 'xss_analysis_deliverable.md',
  },
  'graybox-auth-vuln': {
    name: 'graybox-auth-vuln',
    displayName: 'Gray-box Auth Vuln Agent',
    prerequisites: ['auth-mapper'],
    promptTemplate: 'graybox/vuln-auth',
    deliverableFilename: 'auth_analysis_deliverable.md',
  },
  'graybox-ssrf-vuln': {
    name: 'graybox-ssrf-vuln',
    displayName: 'Gray-box SSRF Vuln Agent',
    prerequisites: ['auth-mapper'],
    promptTemplate: 'graybox/vuln-ssrf',
    deliverableFilename: 'ssrf_analysis_deliverable.md',
  },
  'graybox-authz-vuln': {
    name: 'graybox-authz-vuln',
    displayName: 'Gray-box Authz Vuln Agent',
    prerequisites: ['auth-mapper'],
    promptTemplate: 'graybox/vuln-authz',
    deliverableFilename: 'authz_analysis_deliverable.md',
  },
  'graybox-injection-exploit': {
    name: 'graybox-injection-exploit',
    displayName: 'Gray-box Injection Exploit Agent',
    prerequisites: ['graybox-injection-vuln'],
    promptTemplate: 'graybox/exploit-injection',
    deliverableFilename: 'injection_exploitation_evidence.md',
  },
  'graybox-xss-exploit': {
    name: 'graybox-xss-exploit',
    displayName: 'Gray-box XSS Exploit Agent',
    prerequisites: ['graybox-xss-vuln'],
    promptTemplate: 'graybox/exploit-xss',
    deliverableFilename: 'xss_exploitation_evidence.md',
  },
  'graybox-auth-exploit': {
    name: 'graybox-auth-exploit',
    displayName: 'Gray-box Auth Exploit Agent',
    prerequisites: ['graybox-auth-vuln'],
    promptTemplate: 'graybox/exploit-auth',
    deliverableFilename: 'auth_exploitation_evidence.md',
  },
  'graybox-ssrf-exploit': {
    name: 'graybox-ssrf-exploit',
    displayName: 'Gray-box SSRF Exploit Agent',
    prerequisites: ['graybox-ssrf-vuln'],
    promptTemplate: 'graybox/exploit-ssrf',
    deliverableFilename: 'ssrf_exploitation_evidence.md',
  },
  'graybox-authz-exploit': {
    name: 'graybox-authz-exploit',
    displayName: 'Gray-box Authz Exploit Agent',
    prerequisites: ['graybox-authz-vuln'],
    promptTemplate: 'graybox/exploit-authz',
    deliverableFilename: 'authz_exploitation_evidence.md',
  },
  'graybox-report': {
    name: 'graybox-report',
    displayName: 'Gray-box Report Agent',
    prerequisites: [
      'graybox-injection-exploit', 'graybox-xss-exploit', 'graybox-auth-exploit',
      'graybox-ssrf-exploit', 'graybox-authz-exploit',
    ],
    promptTemplate: 'graybox/report',
    deliverableFilename: 'final_report.md',
    modelTier: 'small',
  },

  // === Mobile Graybox Agents ===
  'mobile-discovery': {
    name: 'mobile-discovery',
    displayName: 'Mobile Discovery Agent',
    prerequisites: [],
    promptTemplate: 'mobile/discovery',
    deliverableFilename: 'mobile_discovery.md',
    modelTier: 'large',
  },
  'mobile-auth-mapper': {
    name: 'mobile-auth-mapper',
    displayName: 'Mobile Auth Mapper Agent',
    prerequisites: ['mobile-discovery'],
    promptTemplate: 'mobile/auth-mapper',
    deliverableFilename: 'mobile_auth_map.md',
  },
  'mobile-injection-vuln': {
    name: 'mobile-injection-vuln',
    displayName: 'Mobile Injection Vuln Agent',
    prerequisites: ['mobile-auth-mapper'],
    promptTemplate: 'mobile/vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'mobile-xss-vuln': {
    name: 'mobile-xss-vuln',
    displayName: 'Mobile XSS Vuln Agent',
    prerequisites: ['mobile-auth-mapper'],
    promptTemplate: 'mobile/vuln-xss',
    deliverableFilename: 'xss_analysis_deliverable.md',
  },
  'mobile-auth-vuln': {
    name: 'mobile-auth-vuln',
    displayName: 'Mobile Auth Vuln Agent',
    prerequisites: ['mobile-auth-mapper'],
    promptTemplate: 'mobile/vuln-auth',
    deliverableFilename: 'auth_analysis_deliverable.md',
  },
  'mobile-ssrf-vuln': {
    name: 'mobile-ssrf-vuln',
    displayName: 'Mobile SSRF Vuln Agent',
    prerequisites: ['mobile-auth-mapper'],
    promptTemplate: 'mobile/vuln-ssrf',
    deliverableFilename: 'ssrf_analysis_deliverable.md',
  },
  'mobile-authz-vuln': {
    name: 'mobile-authz-vuln',
    displayName: 'Mobile Authz Vuln Agent',
    prerequisites: ['mobile-auth-mapper'],
    promptTemplate: 'mobile/vuln-authz',
    deliverableFilename: 'authz_analysis_deliverable.md',
  },
  'mobile-injection-exploit': {
    name: 'mobile-injection-exploit',
    displayName: 'Mobile Injection Exploit Agent',
    prerequisites: ['mobile-injection-vuln'],
    promptTemplate: 'mobile/exploit-injection',
    deliverableFilename: 'injection_exploitation_evidence.md',
  },
  'mobile-xss-exploit': {
    name: 'mobile-xss-exploit',
    displayName: 'Mobile XSS Exploit Agent',
    prerequisites: ['mobile-xss-vuln'],
    promptTemplate: 'mobile/exploit-xss',
    deliverableFilename: 'xss_exploitation_evidence.md',
  },
  'mobile-auth-exploit': {
    name: 'mobile-auth-exploit',
    displayName: 'Mobile Auth Exploit Agent',
    prerequisites: ['mobile-auth-vuln'],
    promptTemplate: 'mobile/exploit-auth',
    deliverableFilename: 'auth_exploitation_evidence.md',
  },
  'mobile-ssrf-exploit': {
    name: 'mobile-ssrf-exploit',
    displayName: 'Mobile SSRF Exploit Agent',
    prerequisites: ['mobile-ssrf-vuln'],
    promptTemplate: 'mobile/exploit-ssrf',
    deliverableFilename: 'ssrf_exploitation_evidence.md',
  },
  'mobile-authz-exploit': {
    name: 'mobile-authz-exploit',
    displayName: 'Mobile Authz Exploit Agent',
    prerequisites: ['mobile-authz-vuln'],
    promptTemplate: 'mobile/exploit-authz',
    deliverableFilename: 'authz_exploitation_evidence.md',
  },
  'mobile-report': {
    name: 'mobile-report',
    displayName: 'Mobile Report Agent',
    prerequisites: [
      'mobile-injection-exploit', 'mobile-xss-exploit', 'mobile-auth-exploit',
      'mobile-ssrf-exploit', 'mobile-authz-exploit',
    ],
    promptTemplate: 'mobile/report',
    deliverableFilename: 'final_report.md',
    modelTier: 'small',
  },

  // === API Graybox Agents ===
  'api-discovery': {
    name: 'api-discovery',
    displayName: 'API Discovery Agent',
    prerequisites: [],
    promptTemplate: 'api/discovery',
    deliverableFilename: 'api_discovery.md',
    modelTier: 'large',
  },
  'api-auth-mapper': {
    name: 'api-auth-mapper',
    displayName: 'API Auth Mapper Agent',
    prerequisites: ['api-discovery'],
    promptTemplate: 'api/auth-mapper',
    deliverableFilename: 'api_auth_map.md',
  },
  'api-injection-vuln': {
    name: 'api-injection-vuln',
    displayName: 'API Injection Vuln Agent',
    prerequisites: ['api-auth-mapper'],
    promptTemplate: 'api/vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'api-xss-vuln': {
    name: 'api-xss-vuln',
    displayName: 'API Response Injection Vuln Agent',
    prerequisites: ['api-auth-mapper'],
    promptTemplate: 'api/vuln-xss',
    deliverableFilename: 'xss_analysis_deliverable.md',
  },
  'api-auth-vuln': {
    name: 'api-auth-vuln',
    displayName: 'API Auth Vuln Agent',
    prerequisites: ['api-auth-mapper'],
    promptTemplate: 'api/vuln-auth',
    deliverableFilename: 'auth_analysis_deliverable.md',
  },
  'api-ssrf-vuln': {
    name: 'api-ssrf-vuln',
    displayName: 'API SSRF Vuln Agent',
    prerequisites: ['api-auth-mapper'],
    promptTemplate: 'api/vuln-ssrf',
    deliverableFilename: 'ssrf_analysis_deliverable.md',
  },
  'api-authz-vuln': {
    name: 'api-authz-vuln',
    displayName: 'API Authz Vuln Agent',
    prerequisites: ['api-auth-mapper'],
    promptTemplate: 'api/vuln-authz',
    deliverableFilename: 'authz_analysis_deliverable.md',
  },
  'api-injection-exploit': {
    name: 'api-injection-exploit',
    displayName: 'API Injection Exploit Agent',
    prerequisites: ['api-injection-vuln'],
    promptTemplate: 'api/exploit-injection',
    deliverableFilename: 'injection_exploitation_evidence.md',
  },
  'api-xss-exploit': {
    name: 'api-xss-exploit',
    displayName: 'API Response Injection Exploit Agent',
    prerequisites: ['api-xss-vuln'],
    promptTemplate: 'api/exploit-xss',
    deliverableFilename: 'xss_exploitation_evidence.md',
  },
  'api-auth-exploit': {
    name: 'api-auth-exploit',
    displayName: 'API Auth Exploit Agent',
    prerequisites: ['api-auth-vuln'],
    promptTemplate: 'api/exploit-auth',
    deliverableFilename: 'auth_exploitation_evidence.md',
  },
  'api-ssrf-exploit': {
    name: 'api-ssrf-exploit',
    displayName: 'API SSRF Exploit Agent',
    prerequisites: ['api-ssrf-vuln'],
    promptTemplate: 'api/exploit-ssrf',
    deliverableFilename: 'ssrf_exploitation_evidence.md',
  },
  'api-authz-exploit': {
    name: 'api-authz-exploit',
    displayName: 'API Authz Exploit Agent',
    prerequisites: ['api-authz-vuln'],
    promptTemplate: 'api/exploit-authz',
    deliverableFilename: 'authz_exploitation_evidence.md',
  },
  'api-report': {
    name: 'api-report',
    displayName: 'API Report Agent',
    prerequisites: [
      'api-injection-exploit', 'api-xss-exploit', 'api-auth-exploit',
      'api-ssrf-exploit', 'api-authz-exploit',
    ],
    promptTemplate: 'api/report',
    deliverableFilename: 'final_report.md',
    modelTier: 'small',
  },
});

// Phase names for metrics aggregation
export type PhaseName = 'pre-recon' | 'recon' | 'discovery' | 'auth-mapping' | 'vulnerability-analysis' | 'exploitation' | 'reporting';

// Map agents to their corresponding phases (single source of truth)
export const AGENT_PHASE_MAP: Readonly<Record<AgentName, PhaseName>> = Object.freeze({
  // Whitebox agents
  'pre-recon': 'pre-recon',
  'recon': 'recon',
  'injection-vuln': 'vulnerability-analysis',
  'xss-vuln': 'vulnerability-analysis',
  'auth-vuln': 'vulnerability-analysis',
  'authz-vuln': 'vulnerability-analysis',
  'ssrf-vuln': 'vulnerability-analysis',
  'injection-exploit': 'exploitation',
  'xss-exploit': 'exploitation',
  'auth-exploit': 'exploitation',
  'authz-exploit': 'exploitation',
  'ssrf-exploit': 'exploitation',
  'report': 'reporting',
  'discovery': 'discovery',
  'auth-mapper': 'auth-mapping',
  'graybox-injection-vuln': 'vulnerability-analysis',
  'graybox-xss-vuln': 'vulnerability-analysis',
  'graybox-auth-vuln': 'vulnerability-analysis',
  'graybox-ssrf-vuln': 'vulnerability-analysis',
  'graybox-authz-vuln': 'vulnerability-analysis',
  'graybox-injection-exploit': 'exploitation',
  'graybox-xss-exploit': 'exploitation',
  'graybox-auth-exploit': 'exploitation',
  'graybox-ssrf-exploit': 'exploitation',
  'graybox-authz-exploit': 'exploitation',
  'graybox-report': 'reporting',

  // Mobile graybox agents
  'mobile-discovery': 'discovery',
  'mobile-auth-mapper': 'auth-mapping',
  'mobile-injection-vuln': 'vulnerability-analysis',
  'mobile-xss-vuln': 'vulnerability-analysis',
  'mobile-auth-vuln': 'vulnerability-analysis',
  'mobile-ssrf-vuln': 'vulnerability-analysis',
  'mobile-authz-vuln': 'vulnerability-analysis',
  'mobile-injection-exploit': 'exploitation',
  'mobile-xss-exploit': 'exploitation',
  'mobile-auth-exploit': 'exploitation',
  'mobile-ssrf-exploit': 'exploitation',
  'mobile-authz-exploit': 'exploitation',
  'mobile-report': 'reporting',

  // API graybox agents
  'api-discovery': 'discovery',
  'api-auth-mapper': 'auth-mapping',
  'api-injection-vuln': 'vulnerability-analysis',
  'api-xss-vuln': 'vulnerability-analysis',
  'api-auth-vuln': 'vulnerability-analysis',
  'api-ssrf-vuln': 'vulnerability-analysis',
  'api-authz-vuln': 'vulnerability-analysis',
  'api-injection-exploit': 'exploitation',
  'api-xss-exploit': 'exploitation',
  'api-auth-exploit': 'exploitation',
  'api-ssrf-exploit': 'exploitation',
  'api-authz-exploit': 'exploitation',
  'api-report': 'reporting',
});

// Factory function for vulnerability queue validators
function createVulnValidator(vulnType: VulnType): AgentValidator {
  return async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    try {
      await validateQueueAndDeliverable(vulnType, sourceDir);
      return true;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Queue validation failed for ${vulnType}: ${errMsg}`);
      return false;
    }
  };
}

// Factory function for exploit deliverable validators
function createExploitValidator(vulnType: VulnType): AgentValidator {
  return async (sourceDir: string): Promise<boolean> => {
    const evidenceFile = path.join(sourceDir, 'deliverables', `${vulnType}_exploitation_evidence.md`);
    return await fs.pathExists(evidenceFile);
  };
}

// MCP agent mapping - assigns each agent to a specific Playwright instance to prevent conflicts
// Keys are promptTemplate values from AGENTS registry
export const MCP_AGENT_MAPPING: Record<string, PlaywrightAgent | AppiumAgent | ApiAgent> = Object.freeze({
  // Whitebox Phase 1: Pre-reconnaissance (actual prompt name is 'pre-recon-code')
  // NOTE: Pre-recon is pure code analysis and doesn't use browser automation,
  // but assigning MCP server anyway for consistency and future extensibility
  'pre-recon-code': 'playwright-agent1',

  // Whitebox Phase 2: Reconnaissance
  recon: 'playwright-agent2',

  // Whitebox Phase 3: Vulnerability Analysis (5 parallel agents)
  'vuln-injection': 'playwright-agent1',
  'vuln-xss': 'playwright-agent2',
  'vuln-auth': 'playwright-agent3',
  'vuln-ssrf': 'playwright-agent4',
  'vuln-authz': 'playwright-agent5',

  // Whitebox Phase 4: Exploitation (5 parallel agents - same as vuln counterparts)
  'exploit-injection': 'playwright-agent1',
  'exploit-xss': 'playwright-agent2',
  'exploit-auth': 'playwright-agent3',
  'exploit-ssrf': 'playwright-agent4',
  'exploit-authz': 'playwright-agent5',

  // Whitebox Phase 5: Reporting (actual prompt name is 'report-executive')
  'report-executive': 'playwright-agent3',

  // Gray-box discovery and auth mapping
  'graybox/discovery': 'playwright-agent1',
  'graybox/auth-mapper': 'playwright-agent2',

  // Gray-box vulnerability analysis (5 parallel agents)
  'graybox/vuln-injection': 'playwright-agent1',
  'graybox/vuln-xss': 'playwright-agent2',
  'graybox/vuln-auth': 'playwright-agent3',
  'graybox/vuln-ssrf': 'playwright-agent4',
  'graybox/vuln-authz': 'playwright-agent5',

  // Gray-box exploitation (5 parallel agents - same slots as vuln counterparts)
  'graybox/exploit-injection': 'playwright-agent1',
  'graybox/exploit-xss': 'playwright-agent2',
  'graybox/exploit-auth': 'playwright-agent3',
  'graybox/exploit-ssrf': 'playwright-agent4',
  'graybox/exploit-authz': 'playwright-agent5',

  // Gray-box reporting
  'graybox/report': 'playwright-agent1',

  // Mobile discovery and auth mapping
  'mobile/discovery': 'appium-agent1',
  'mobile/auth-mapper': 'appium-agent2',

  // Mobile vulnerability analysis (5 parallel agents)
  'mobile/vuln-injection': 'appium-agent1',
  'mobile/vuln-xss': 'appium-agent2',
  'mobile/vuln-auth': 'appium-agent3',
  'mobile/vuln-ssrf': 'appium-agent4',
  'mobile/vuln-authz': 'appium-agent5',

  // Mobile exploitation (5 parallel agents — same slots as vuln counterparts)
  'mobile/exploit-injection': 'appium-agent1',
  'mobile/exploit-xss': 'appium-agent2',
  'mobile/exploit-auth': 'appium-agent3',
  'mobile/exploit-ssrf': 'appium-agent4',
  'mobile/exploit-authz': 'appium-agent5',

  // Mobile reporting
  'mobile/report': 'appium-agent1',

  // API agents — no browser/device automation, only Bash+curl + shannon-helper
  'api/discovery': 'api-only',
  'api/auth-mapper': 'api-only',
  'api/vuln-injection': 'api-only',
  'api/vuln-xss': 'api-only',
  'api/vuln-auth': 'api-only',
  'api/vuln-ssrf': 'api-only',
  'api/vuln-authz': 'api-only',
  'api/exploit-injection': 'api-only',
  'api/exploit-xss': 'api-only',
  'api/exploit-auth': 'api-only',
  'api/exploit-ssrf': 'api-only',
  'api/exploit-authz': 'api-only',
  'api/report': 'api-only',
});

// Direct agent-to-validator mapping - much simpler than pattern matching
export const AGENT_VALIDATORS: Record<AgentName, AgentValidator> = Object.freeze({
  // Whitebox: Pre-reconnaissance agent - validates the code analysis deliverable
  'pre-recon': async (sourceDir: string): Promise<boolean> => {
    const codeAnalysisFile = path.join(sourceDir, 'deliverables', 'code_analysis_deliverable.md');
    return await fs.pathExists(codeAnalysisFile);
  },

  // Whitebox: Reconnaissance agent
  recon: async (sourceDir: string): Promise<boolean> => {
    const reconFile = path.join(sourceDir, 'deliverables', 'recon_deliverable.md');
    return await fs.pathExists(reconFile);
  },

  // Whitebox: Vulnerability analysis agents
  'injection-vuln': createVulnValidator('injection'),
  'xss-vuln': createVulnValidator('xss'),
  'auth-vuln': createVulnValidator('auth'),
  'ssrf-vuln': createVulnValidator('ssrf'),
  'authz-vuln': createVulnValidator('authz'),

  // Whitebox: Exploitation agents
  'injection-exploit': createExploitValidator('injection'),
  'xss-exploit': createExploitValidator('xss'),
  'auth-exploit': createExploitValidator('auth'),
  'ssrf-exploit': createExploitValidator('ssrf'),
  'authz-exploit': createExploitValidator('authz'),

  // Whitebox: Executive report agent
  report: async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(
      sourceDir,
      'deliverables',
      'final_report.md'
    );
    const reportExists = await fs.pathExists(reportFile);
    if (!reportExists) {
      logger.error('Missing required deliverable: final_report.md');
    }
    return reportExists;
  },

  // Gray-box discovery and auth mapping
  'discovery': async (sourceDir: string): Promise<boolean> => {
    const file = path.join(sourceDir, 'deliverables', 'graybox_discovery.md');
    return await fs.pathExists(file);
  },
  'auth-mapper': async (sourceDir: string, _logger: ActivityLogger, personaName?: string): Promise<boolean> => {
    const file = personaName
      ? path.join(sourceDir, 'deliverables', 'auth', `graybox_auth_map_${personaName}.md`)
      : path.join(sourceDir, 'deliverables', 'graybox_auth_map.md');
    return await fs.pathExists(file);
  },

  // Gray-box vulnerability analysis agents
  'graybox-injection-vuln': createVulnValidator('injection'),
  'graybox-xss-vuln': createVulnValidator('xss'),
  'graybox-auth-vuln': createVulnValidator('auth'),
  'graybox-ssrf-vuln': createVulnValidator('ssrf'),
  'graybox-authz-vuln': createVulnValidator('authz'),

  // Gray-box exploitation agents
  'graybox-injection-exploit': createExploitValidator('injection'),
  'graybox-xss-exploit': createExploitValidator('xss'),
  'graybox-auth-exploit': createExploitValidator('auth'),
  'graybox-ssrf-exploit': createExploitValidator('ssrf'),
  'graybox-authz-exploit': createExploitValidator('authz'),

  // Gray-box report
  'graybox-report': async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(
      sourceDir,
      'deliverables',
      'final_report.md'
    );
    const reportExists = await fs.pathExists(reportFile);
    if (!reportExists) {
      logger.error('Missing required deliverable: final_report.md');
    }
    return reportExists;
  },

  // Mobile discovery and auth mapping
  'mobile-discovery': async (sourceDir: string): Promise<boolean> => {
    const file = path.join(sourceDir, 'deliverables', 'mobile_discovery.md');
    return await fs.pathExists(file);
  },
  'mobile-auth-mapper': async (sourceDir: string, _logger: ActivityLogger, personaName?: string): Promise<boolean> => {
    const file = personaName
      ? path.join(sourceDir, 'deliverables', 'auth', `mobile_auth_map_${personaName}.md`)
      : path.join(sourceDir, 'deliverables', 'mobile_auth_map.md');
    return await fs.pathExists(file);
  },

  // Mobile vulnerability analysis agents
  'mobile-injection-vuln': createVulnValidator('injection'),
  'mobile-xss-vuln': createVulnValidator('xss'),
  'mobile-auth-vuln': createVulnValidator('auth'),
  'mobile-ssrf-vuln': createVulnValidator('ssrf'),
  'mobile-authz-vuln': createVulnValidator('authz'),

  // Mobile exploitation agents
  'mobile-injection-exploit': createExploitValidator('injection'),
  'mobile-xss-exploit': createExploitValidator('xss'),
  'mobile-auth-exploit': createExploitValidator('auth'),
  'mobile-ssrf-exploit': createExploitValidator('ssrf'),
  'mobile-authz-exploit': createExploitValidator('authz'),

  // Mobile report
  'mobile-report': async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(
      sourceDir,
      'deliverables',
      'final_report.md'
    );
    const reportExists = await fs.pathExists(reportFile);
    if (!reportExists) {
      logger.error('Missing required deliverable: final_report.md');
    }
    return reportExists;
  },

  // API discovery and auth mapping
  'api-discovery': async (sourceDir: string): Promise<boolean> => {
    const file = path.join(sourceDir, 'deliverables', 'api_discovery.md');
    return await fs.pathExists(file);
  },
  'api-auth-mapper': async (sourceDir: string, _logger: ActivityLogger, personaName?: string): Promise<boolean> => {
    const file = personaName
      ? path.join(sourceDir, 'deliverables', 'auth', `api_auth_map_${personaName}.md`)
      : path.join(sourceDir, 'deliverables', 'api_auth_map.md');
    return await fs.pathExists(file);
  },

  // API vulnerability analysis agents
  'api-injection-vuln': createVulnValidator('injection'),
  'api-xss-vuln': createVulnValidator('xss'),
  'api-auth-vuln': createVulnValidator('auth'),
  'api-ssrf-vuln': createVulnValidator('ssrf'),
  'api-authz-vuln': createVulnValidator('authz'),

  // API exploitation agents
  'api-injection-exploit': createExploitValidator('injection'),
  'api-xss-exploit': createExploitValidator('xss'),
  'api-auth-exploit': createExploitValidator('auth'),
  'api-ssrf-exploit': createExploitValidator('ssrf'),
  'api-authz-exploit': createExploitValidator('authz'),

  // API report
  'api-report': async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(
      sourceDir,
      'deliverables',
      'final_report.md'
    );
    const reportExists = await fs.pathExists(reportFile);
    if (!reportExists) {
      logger.error('Missing required deliverable: final_report.md');
    }
    return reportExists;
  },
});
