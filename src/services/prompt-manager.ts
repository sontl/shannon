// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { fs, path } from 'zx';
import { PentestError, handlePromptError } from './error-handling.js';
import { MCP_AGENT_MAPPING } from '../session-manager.js';
import type { Authentication, DistributedConfig, Persona } from '../types/config.js';
import type { ActivityLogger } from '../types/activity-logger.js';

interface PromptVariables {
  webUrl: string;
  repoPath: string;
  // Source code root for whitebox mode. Always derived as `{repoPath}/src`, surfaced
  // to prompts via {{SRC_PATH}}. Required by whitebox prompts; graybox/mobile/api
  // prompts may still reference it as optional context when `src/` exists.
  srcPath: string;
  MCP_SERVER?: string;
  // Human-readable summary of which optional subfolders are present under repoPath
  // (e.g., "docs, schemas, auth" or "docs only"). Injected via {{DOCS_STRUCTURE}}.
  docsStructure?: string;
  // Mobile-specific variables (optional — only set when target=mobile)
  appPath?: string;
  platform?: string;
  deviceId?: string;
  appiumUrl?: string;
  backendApiUrl?: string;
  bundleId?: string;
  // Persona context for the agent invocation. When set, login instructions and
  // {{PERSONA_*}} placeholders are interpolated for this specific persona.
  personaName?: string;
}

interface IncludeReplacement {
  placeholder: string;
  content: string;
}

// Resolve effective login config for a persona — persona-level overrides win
// over the authentication-level defaults.
function resolvePersonaLogin(
  persona: Persona,
  authentication: Authentication
): { login_flow: string[]; login_url: string | undefined } {
  return {
    login_flow: persona.login_flow ?? authentication.login_flow ?? [],
    login_url: persona.login_url ?? authentication.login_url,
  };
}

// Pure function: Build login instructions for a single persona.
async function buildLoginInstructions(
  persona: Persona,
  authentication: Authentication,
  logger: ActivityLogger
): Promise<string> {
  try {
    const loginInstructionsPath = path.join(import.meta.dirname, '..', '..', 'prompts', 'shared', 'login-instructions.txt');

    if (!await fs.pathExists(loginInstructionsPath)) {
      throw new PentestError(
        'Login instructions template not found',
        'filesystem',
        false,
        { loginInstructionsPath }
      );
    }

    const fullTemplate = await fs.readFile(loginInstructionsPath, 'utf8');

    const getSection = (content: string, sectionName: string): string => {
      const regex = new RegExp(`<!-- BEGIN:${sectionName} -->([\\s\\S]*?)<!-- END:${sectionName} -->`, 'g');
      const match = regex.exec(content);
      return match ? match[1]!.trim() : '';
    };

    const loginType = authentication.login_type?.toUpperCase();
    let loginInstructions = '';

    const commonSection = getSection(fullTemplate, 'COMMON');
    const authSection = loginType ? getSection(fullTemplate, loginType) : '';
    const verificationSection = getSection(fullTemplate, 'VERIFICATION');

    if (!commonSection && !authSection && !verificationSection) {
      logger.warn('Section markers not found, using full login instructions template');
      loginInstructions = fullTemplate;
    } else {
      loginInstructions = [commonSection, authSection, verificationSection]
        .filter(section => section)
        .join('\n\n');
    }

    const effective = resolvePersonaLogin(persona, authentication);
    let userInstructions = effective.login_flow.join('\n');

    const { credentials } = persona;
    if (credentials.username) {
      userInstructions = userInstructions.replace(/\$username/g, credentials.username);
    }
    if (credentials.password) {
      userInstructions = userInstructions.replace(/\$password/g, credentials.password);
    }
    if (credentials.totp_secret) {
      userInstructions = userInstructions.replace(/\$totp/g, `generated TOTP code using secret "${credentials.totp_secret}"`);
    }

    loginInstructions = loginInstructions.replace(/{{user_instructions}}/g, userInstructions);

    if (credentials.totp_secret) {
      loginInstructions = loginInstructions.replace(/{{totp_secret}}/g, credentials.totp_secret);
    }

    return loginInstructions;
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new PentestError(
      `Failed to build login instructions: ${errMsg}`,
      'config',
      false,
      { personaName: persona.name, originalError: errMsg }
    );
  }
}

// Pure function: Process @include() directives
async function processIncludes(content: string, baseDir: string): Promise<string> {
  const includeRegex = /@include\(([^)]+)\)/g;
  const resolvedBase = path.resolve(baseDir);

  const replacements: IncludeReplacement[] = await Promise.all(
    Array.from(content.matchAll(includeRegex)).map(async (match) => {
      const includePath = path.resolve(baseDir, match[1]!);
      if (!includePath.startsWith(resolvedBase + path.sep) && includePath !== resolvedBase) {
        throw new PentestError(
          `Path traversal detected in @include(): ${match[1]}`,
          'prompt',
          false,
          { includePath, baseDir: resolvedBase }
        );
      }
      const sharedContent = await fs.readFile(includePath, 'utf8');
      return {
        placeholder: match[0],
        content: sharedContent,
      };
    })
  );

  for (const replacement of replacements) {
    content = content.replace(replacement.placeholder, replacement.content);
  }
  return content;
}

// Pure function: Variable interpolation
async function interpolateVariables(
  template: string,
  variables: PromptVariables,
  config: DistributedConfig | null = null,
  logger: ActivityLogger
): Promise<string> {
  try {
    if (!template || typeof template !== 'string') {
      throw new PentestError(
        'Template must be a non-empty string',
        'validation',
        false,
        { templateType: typeof template, templateLength: template?.length }
      );
    }

    const isMobile = !!variables.bundleId || !!variables.appPath;
    // Network engagements address scope via pipeline.network.scope.targets — webUrl
    // is optional (treated as a documentation hint when provided).
    const isNetwork = !!config?.network;

    if (!variables || (!isMobile && !isNetwork && !variables.webUrl) || !variables.repoPath || !variables.srcPath) {
      throw new PentestError(
        'Variables must include repoPath and srcPath (and webUrl for web targets, appPath for mobile, or network config for network targets)',
        'validation',
        false,
        { variables: Object.keys(variables || {}) }
      );
    }

    // Resolve persona context (if any) up front for {{PERSONA_*}} placeholders.
    const activePersona = variables.personaName && config?.authentication
      ? config.authentication.personas.find(p => p.name === variables.personaName) ?? null
      : null;

    let result = template
      .replace(/{{WEB_URL}}/g, variables.webUrl || variables.backendApiUrl || '')
      .replace(/{{REPO_PATH}}/g, variables.repoPath)
      .replace(/{{SRC_PATH}}/g, variables.srcPath)
      .replace(/{{MCP_SERVER}}/g, variables.MCP_SERVER || 'playwright-agent1')
      .replace(/{{DOCS_STRUCTURE}}/g, variables.docsStructure || 'not scanned')
      .replace(/{{APP_PATH}}/g, variables.appPath || '')
      .replace(/{{PLATFORM}}/g, variables.platform || '')
      .replace(/{{DEVICE_ID}}/g, variables.deviceId || '')
      .replace(/{{APPIUM_URL}}/g, variables.appiumUrl || 'http://localhost:4723')
      .replace(/{{BACKEND_API_URL}}/g, variables.backendApiUrl || '')
      .replace(/{{BUNDLE_ID}}/g, variables.bundleId || '')
      .replace(/{{PERSONA_NAME}}/g, activePersona?.name || variables.personaName || '')
      .replace(/{{PERSONA_ROLE}}/g, activePersona?.role || '');

    if (config) {
      // Handle rules section - if both are empty, use cleaner messaging
      const hasAvoidRules = config.avoid && config.avoid.length > 0;
      const hasFocusRules = config.focus && config.focus.length > 0;

      if (!hasAvoidRules && !hasFocusRules) {
        // Replace the entire rules section with a clean message
        const cleanRulesSection = '<rules>\nNo specific rules or focus areas provided for this test.\n</rules>';
        result = result.replace(/<rules>[\s\S]*?<\/rules>/g, cleanRulesSection);
      } else {
        const avoidRules = hasAvoidRules ? config.avoid!.map(r => `- ${r.description}`).join('\n') : 'None';
        const focusRules = hasFocusRules ? config.focus!.map(r => `- ${r.description}`).join('\n') : 'None';

        result = result
          .replace(/{{RULES_AVOID}}/g, avoidRules)
          .replace(/{{RULES_FOCUS}}/g, focusRules);
      }

      // Inject schema hints for graybox discovery
      if (config.schemas && config.schemas.length > 0) {
        const schemaLines = config.schemas.map(s => `- ${s.type.toUpperCase()}: ${s.url}`).join('\n');
        result = result.replace(/{{SCHEMAS_CONTEXT}}/g,
          `The following API schemas have been provided — ingest these first before dynamic discovery:\n${schemaLines}`
        );
      } else {
        result = result.replace(/{{SCHEMAS_CONTEXT}}/g,
          'No schemas provided — discover endpoints dynamically.'
        );
      }

      // Build login instructions for the active persona.
      // Picks: explicit personaName ⟶ first persona ⟶ none.
      const loginPersona = activePersona ?? config.authentication?.personas[0] ?? null;
      const hasLoginFlow = !!(loginPersona?.login_flow ?? config.authentication?.login_flow);
      if (loginPersona && hasLoginFlow) {
        const loginInstructions = await buildLoginInstructions(loginPersona, config.authentication!, logger);
        result = result.replace(/{{LOGIN_INSTRUCTIONS}}/g, loginInstructions);
      } else {
        result = result.replace(/{{LOGIN_INSTRUCTIONS}}/g, '');
      }

      // Network-tier placeholders. Substituted whenever a network config is
      // present (even on non-network tiers, the values default to safe blanks).
      const net = config.network;
      if (net) {
        const scopeBlock = [
          `Targets:\n${net.scope.targets.map((t) => `  - ${t}`).join('\n')}`,
          net.scope.excludes && net.scope.excludes.length > 0
            ? `Excludes (out-of-scope):\n${net.scope.excludes.map((t) => `  - ${t}`).join('\n')}`
            : 'Excludes: (none)',
        ].join('\n\n');
        result = result
          .replace(/{{ENGAGEMENT_MODE}}/g, net.engagement_mode)
          .replace(/{{NETWORK_SCOPE}}/g, scopeBlock)
          .replace(/{{AD_ENABLED}}/g, String(net.ad.enabled))
          .replace(/{{AD_DOMAIN}}/g, net.ad.domain || '(auto-discover)')
          .replace(/{{DC_IP}}/g, net.ad.dc_ip || '(auto-discover)')
          .replace(/{{VULN_SCANNER}}/g, net.scanners.vuln_scanner)
          .replace(/{{RELAY_ENABLED}}/g, String(net.relay.enabled))
          .replace(/{{RELAY_DURATION_MINUTES}}/g, String(net.relay.duration_minutes))
          .replace(/{{CRACKING_ENABLED}}/g, String(net.cracking.enabled))
          .replace(/{{CRACKING_BUDGET_MINUTES}}/g, String(net.cracking.budget_minutes))
          .replace(/{{CRACKING_COMPUTE}}/g, net.cracking.compute)
          .replace(/{{LOCKOUT_THRESHOLD}}/g, String(net.safety.lockout_threshold))
          .replace(/{{COERCION_AUTHORIZED}}/g, String(net.safety.coercion_authorized))
          .replace(/{{AVOID_PRODUCTION_DCS}}/g, String(net.safety.avoid_production_dcs))
          .replace(/{{ATTACK_VERSION}}/g, String(net.attack_framework.attack_version));
      } else {
        // Non-network tier — fill placeholders with safe blanks so the
        // unresolved-placeholders warning at the end doesn't fire on shared partials.
        result = result
          .replace(/{{ENGAGEMENT_MODE}}/g, 'n/a')
          .replace(/{{NETWORK_SCOPE}}/g, 'n/a — network tier not active')
          .replace(/{{AD_ENABLED}}/g, 'false')
          .replace(/{{AD_DOMAIN}}/g, '')
          .replace(/{{DC_IP}}/g, '')
          .replace(/{{VULN_SCANNER}}/g, 'none')
          .replace(/{{RELAY_ENABLED}}/g, 'false')
          .replace(/{{RELAY_DURATION_MINUTES}}/g, '0')
          .replace(/{{CRACKING_ENABLED}}/g, 'false')
          .replace(/{{CRACKING_BUDGET_MINUTES}}/g, '0')
          .replace(/{{CRACKING_COMPUTE}}/g, 'cpu')
          .replace(/{{LOCKOUT_THRESHOLD}}/g, '0')
          .replace(/{{COERCION_AUTHORIZED}}/g, 'false')
          .replace(/{{AVOID_PRODUCTION_DCS}}/g, 'true')
          .replace(/{{ATTACK_VERSION}}/g, '17');
      }
    } else {
      // Replace the entire rules section with a clean message when no config provided
      const cleanRulesSection = '<rules>\nNo specific rules or focus areas provided for this test.\n</rules>';
      result = result.replace(/<rules>[\s\S]*?<\/rules>/g, cleanRulesSection);
      result = result.replace(/{{LOGIN_INSTRUCTIONS}}/g, '');
      result = result.replace(/{{SCHEMAS_CONTEXT}}/g, 'No schemas provided — discover endpoints dynamically.');
    }

    // Validate that all placeholders have been replaced (excluding instructional text)
    const remainingPlaceholders = result.match(/\{\{[^}]+\}\}/g);
    if (remainingPlaceholders) {
      logger.warn(`Found unresolved placeholders in prompt: ${remainingPlaceholders.join(', ')}`);
    }

    return result;
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new PentestError(
      `Variable interpolation failed: ${errMsg}`,
      'prompt',
      false,
      { originalError: errMsg }
    );
  }
}

// Pure function: Load and interpolate prompt template
export async function loadPrompt(
  promptName: string,
  variables: PromptVariables,
  config: DistributedConfig | null = null,
  pipelineTestingMode: boolean = false,
  logger: ActivityLogger
): Promise<string> {
  try {
    // 1. Resolve prompt file path
    const baseDir = pipelineTestingMode ? 'prompts/pipeline-testing' : 'prompts';
    const promptsDir = path.join(import.meta.dirname, '..', '..', baseDir);
    const promptPath = path.join(promptsDir, `${promptName}.txt`);

    if (pipelineTestingMode) {
      logger.info(`Using pipeline testing prompt: ${promptPath}`);
    }

    if (!await fs.pathExists(promptPath)) {
      throw new PentestError(
        `Prompt file not found: ${promptPath}`,
        'prompt',
        false,
        { promptName, promptPath }
      );
    }

    // 2. Assign MCP server based on agent name
    const enhancedVariables: PromptVariables = { ...variables };

    const mcpServer = MCP_AGENT_MAPPING[promptName as keyof typeof MCP_AGENT_MAPPING];
    if (mcpServer) {
      enhancedVariables.MCP_SERVER = mcpServer;
      logger.info(`Assigned ${promptName} -> ${enhancedVariables.MCP_SERVER}`);
    } else {
      enhancedVariables.MCP_SERVER = 'playwright-agent1';
      logger.warn(`Unknown agent ${promptName}, using fallback -> ${enhancedVariables.MCP_SERVER}`);
    }

    // 3. Read template file
    let template = await fs.readFile(promptPath, 'utf8');

    // 4. Process @include directives
    template = await processIncludes(template, promptsDir);

    // 5. Interpolate variables and return final prompt
    return await interpolateVariables(template, enhancedVariables, config, logger);
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    const promptError = handlePromptError(promptName, error as Error);
    throw promptError.error;
  }
}
