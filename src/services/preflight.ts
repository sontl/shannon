// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Preflight Validation Service
 *
 * Runs cheap, fast checks before any agent execution begins.
 * Catches configuration and credential problems early, saving
 * time and API costs compared to failing mid-pipeline.
 *
 * Checks run sequentially, cheapest first:
 * 1. Repository path layout matches the active pipeline mode:
 *    - graybox/mobile/api: require non-empty `{repoPath}/docs/` (read-only docs).
 *    - whitebox:           require non-empty `{repoPath}/src/`  (read-only source code).
 * 2. Config file parses and validates (if provided)
 * 3. Credentials validate via Claude Agent SDK query (API key, OAuth, Bedrock, Vertex AI, or router mode)
 */

import fs from 'fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import { PentestError, isRetryableError } from './error-handling.js';
import { ErrorCode } from '../types/errors.js';
import { type Result, ok, err } from '../types/result.js';
import { parseConfig } from '../config-parser.js';
import { resolveModel } from '../ai/models.js';
import type { ActivityLogger } from '../types/activity-logger.js';
import type { PipelineTarget } from '../types/config.js';

/** Pipeline mode — determines whether the repo holds docs/ (graybox) or src/ (whitebox). */
export type PipelineMode = 'whitebox' | 'graybox';

// === Repository Validation ===

/** Optional input subfolders the pipeline knows about. */
export const OPTIONAL_DOC_SUBDIRS = ['schemas', 'api', 'auth', 'remediation'] as const;

/** Result of scanning the input docs folder. */
export interface DocsLayout {
  hasDocs: boolean;
  // True if {repoPath}/src/ exists and is non-empty. Required for whitebox mode,
  // optional and informational otherwise (graybox/mobile/api may also ship source).
  hasSrc: boolean;
  presentOptional: string[];
  missingOptional: string[];
}

async function hasAtLeastOneEntry(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inspect `{repoPath}/docs/`, `{repoPath}/src/`, `{repoPath}/schemas/`,
 * `{repoPath}/api/`, `{repoPath}/auth/` and return which optional subfolders
 * exist. Exposed so callers can surface the layout to agents.
 */
export async function scanDocsLayout(repoPath: string): Promise<DocsLayout> {
  const docsDir = `${repoPath}/docs`;
  const srcDir = `${repoPath}/src`;
  const hasDocs = (await isDirectory(docsDir)) && (await hasAtLeastOneEntry(docsDir));
  const hasSrc = (await isDirectory(srcDir)) && (await hasAtLeastOneEntry(srcDir));

  const presentOptional: string[] = [];
  const missingOptional: string[] = [];
  for (const sub of OPTIONAL_DOC_SUBDIRS) {
    if (await isDirectory(`${repoPath}/${sub}`)) {
      presentOptional.push(sub);
    } else {
      missingOptional.push(sub);
    }
  }

  return { hasDocs, hasSrc, presentOptional, missingOptional };
}

async function validateRepo(
  repoPath: string,
  logger: ActivityLogger,
  mode: PipelineMode
): Promise<Result<void, PentestError>> {
  logger.info('Checking input repo path...', { repoPath, mode });

  // 1. Check repo directory exists
  try {
    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      return err(
        new PentestError(
          `Input path is not a directory: ${repoPath}`,
          'config',
          false,
          { repoPath },
          ErrorCode.REPO_NOT_FOUND
        )
      );
    }
  } catch {
    return err(
      new PentestError(
        `Input path does not exist: ${repoPath}`,
        'config',
        false,
        { repoPath },
        ErrorCode.REPO_NOT_FOUND
      )
    );
  }

  const layout = await scanDocsLayout(repoPath);

  // 2. Mode-specific requirement
  if (mode === 'whitebox') {
    if (!layout.hasSrc) {
      return err(
        new PentestError(
          `Whitebox mode requires source code at ${repoPath}/src/, but the folder is missing or empty. ` +
          `Place the target application's source tree under ${repoPath}/src/ ` +
          `(read-only; agents never write back).`,
          'config',
          false,
          { repoPath, expected: `${repoPath}/src/`, mode },
          ErrorCode.REPO_NOT_FOUND
        )
      );
    }
    if (!layout.hasDocs) {
      logger.warn(
        `Whitebox mode: ${repoPath}/docs/ is missing — agents will rely on source code only. ` +
        `Add docs/ for architecture/overview context.`
      );
    }
  } else {
    // graybox: docs/ is mandatory, src/ is optional context.
    if (!layout.hasDocs) {
      return err(
        new PentestError(
          `Input docs folder missing or empty: ${repoPath}/docs/. ` +
          `The project docs folder must contain at least one file ` +
          `(overview, architecture, user flows, or business logic).`,
          'config',
          false,
          { repoPath, expected: `${repoPath}/docs/`, mode },
          ErrorCode.REPO_NOT_FOUND
        )
      );
    }
    if (layout.hasSrc) {
      logger.info(
        `Graybox mode: source code detected at ${repoPath}/src/ — surfaced to agents as optional context.`
      );
    }
  }

  // 3. Warn about optional subfolders that are missing (does not fail preflight)
  if (layout.missingOptional.length > 0) {
    logger.warn(
      `Optional docs subfolders not found: ${layout.missingOptional.join(', ')}. ` +
      `Testing will proceed without them.`
    );
  }
  const present: string[] = [];
  if (layout.hasDocs) present.push('docs');
  if (layout.hasSrc) present.push('src');
  present.push(...layout.presentOptional);
  logger.info('Input repo OK', { repoPath, mode, present });
  return ok(undefined);
}

// === Config Validation ===

async function validateConfig(
  configPath: string,
  logger: ActivityLogger
): Promise<Result<void, PentestError>> {
  logger.info('Validating configuration file...', { configPath });

  try {
    await parseConfig(configPath);
    logger.info('Configuration file OK');
    return ok(undefined);
  } catch (error) {
    if (error instanceof PentestError) {
      return err(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new PentestError(
        `Configuration validation failed: ${message}`,
        'config',
        false,
        { configPath },
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }
}

// === Credential Validation ===

/** Map SDK error type to a human-readable preflight PentestError. */
function classifySdkError(
  sdkError: SDKAssistantMessageError,
  authType: string
): Result<void, PentestError> {
  switch (sdkError) {
    case 'authentication_failed':
      return err(new PentestError(
        `Invalid ${authType}. Check your credentials in .env and try again.`,
        'config', false, { authType, sdkError }, ErrorCode.AUTH_FAILED
      ));
    case 'billing_error':
      return err(new PentestError(
        `Anthropic account has a billing issue. Add credits or check your billing dashboard.`,
        'billing', true, { authType, sdkError }, ErrorCode.BILLING_ERROR
      ));
    case 'rate_limit':
      return err(new PentestError(
        `Anthropic rate limit or spending cap reached. Wait a few minutes and try again.`,
        'billing', true, { authType, sdkError }, ErrorCode.BILLING_ERROR
      ));
    case 'server_error':
      return err(new PentestError(
        `Anthropic API is temporarily unavailable. Try again shortly.`,
        'network', true, { authType, sdkError }
      ));
    default:
      return err(new PentestError(
        `${authType} validation failed unexpectedly. Check your credentials in .env.`,
        'config', false, { authType, sdkError }, ErrorCode.AUTH_FAILED
      ));
  }
}

/** Validate credentials via a minimal Claude Agent SDK query. */
async function validateCredentials(
  logger: ActivityLogger
): Promise<Result<void, PentestError>> {
  // 1. Custom base URL — validate endpoint is reachable via SDK query
  if (process.env.ANTHROPIC_BASE_URL) {
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    logger.info(`Validating custom base URL: ${baseUrl}`);

    try {
      for await (const message of query({ prompt: 'hi', options: { model: resolveModel('small'), maxTurns: 1 } })) {
        if (message.type === 'assistant' && message.error) {
          return classifySdkError(message.error, `custom endpoint (${baseUrl})`);
        }
        if (message.type === 'result') {
          break;
        }
      }

      logger.info('Custom base URL OK');
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new PentestError(
          `Custom base URL unreachable: ${baseUrl} — ${message}`,
          'network',
          false,
          { baseUrl },
          ErrorCode.AUTH_FAILED
        )
      );
    }
  }

  // 2. Bedrock mode — validate required AWS credentials are present
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    const required = ['AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_SMALL_MODEL', 'ANTHROPIC_MEDIUM_MODEL', 'ANTHROPIC_LARGE_MODEL'];
    const missing = required.filter(v => !process.env[v]);
    if (missing.length > 0) {
      return err(
        new PentestError(
          `Bedrock mode requires the following env vars in .env: ${missing.join(', ')}`,
          'config',
          false,
          { missing },
          ErrorCode.AUTH_FAILED
        )
      );
    }
    logger.info('Bedrock credentials OK');
    return ok(undefined);
  }

  // 3. Vertex AI mode — validate required GCP credentials are present
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') {
    const required = ['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_SMALL_MODEL', 'ANTHROPIC_MEDIUM_MODEL', 'ANTHROPIC_LARGE_MODEL'];
    const missing = required.filter(v => !process.env[v]);
    if (missing.length > 0) {
      return err(
        new PentestError(
          `Vertex AI mode requires the following env vars in .env: ${missing.join(', ')}`,
          'config',
          false,
          { missing },
          ErrorCode.AUTH_FAILED
        )
      );
    }
    // Validate service account credentials file is accessible
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      return err(
        new PentestError(
          'Vertex AI mode requires GOOGLE_APPLICATION_CREDENTIALS pointing to a service account key JSON file',
          'config',
          false,
          {},
          ErrorCode.AUTH_FAILED
        )
      );
    }
    try {
      await fs.access(credPath);
    } catch {
      return err(
        new PentestError(
          `Service account key file not found at: ${credPath}`,
          'config',
          false,
          { credPath },
          ErrorCode.AUTH_FAILED
        )
      );
    }
    logger.info('Vertex AI credentials OK');
    return ok(undefined);
  }

  // 4. Check that at least one credential is present
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return err(
      new PentestError(
        'No API credentials found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in .env (or use CLAUDE_CODE_USE_BEDROCK=1 for AWS Bedrock, or CLAUDE_CODE_USE_VERTEX=1 for Google Vertex AI)',
        'config',
        false,
        {},
        ErrorCode.AUTH_FAILED
      )
    );
  }

  // 5. Validate via SDK query
  const authType = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'OAuth token' : 'API key';
  logger.info(`Validating ${authType} via SDK...`);

  try {
    for await (const message of query({ prompt: 'hi', options: { model: resolveModel('small'), maxTurns: 1 } })) {
      if (message.type === 'assistant' && message.error) {
        return classifySdkError(message.error, authType);
      }
      if (message.type === 'result') {
        break;
      }
    }

    logger.info(`${authType} OK`);
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableError(error instanceof Error ? error : new Error(message));

    return err(
      new PentestError(
        retryable
          ? `Failed to reach Anthropic API. Check your network connection.`
          : `${authType} validation failed: ${message}`,
        retryable ? 'network' : 'config',
        retryable,
        { authType },
        retryable ? undefined : ErrorCode.AUTH_FAILED
      )
    );
  }
}

// === Mobile Validation ===

async function validateMobilePrerequisites(
  configPath: string | undefined,
  logger: ActivityLogger
): Promise<Result<void, PentestError>> {
  if (!configPath) {
    return err(
      new PentestError(
        'Mobile target requires a config file with a "mobile" section',
        'config',
        false,
        {},
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }

  const config = await parseConfig(configPath);
  if (!config.mobile) {
    return err(
      new PentestError(
        'Mobile target requires a "mobile" section in the config file',
        'config',
        false,
        {},
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }

  // Validate APK/IPA file exists (only if app_path is specified in config)
  if (config.mobile.app_path) {
    try {
      const stats = await fs.stat(config.mobile.app_path);
      if (!stats.isFile()) {
        return err(
          new PentestError(
            `mobile.app_path is not a file: ${config.mobile.app_path}`,
            'config',
            false,
            { appPath: config.mobile.app_path },
            ErrorCode.CONFIG_VALIDATION_FAILED
          )
        );
      }
    } catch {
      return err(
        new PentestError(
          `Mobile app file not found: ${config.mobile.app_path}`,
          'config',
          false,
          { appPath: config.mobile.app_path },
          ErrorCode.CONFIG_VALIDATION_FAILED
        )
      );
    }
  }

  logger.info('Mobile prerequisites OK', {
    platform: config.mobile.platform,
  });
  return ok(undefined);
}

// === Network Validation ===

async function validateNetworkPrerequisites(
  configPath: string | undefined,
  logger: ActivityLogger
): Promise<Result<void, PentestError>> {
  if (!configPath) {
    return err(
      new PentestError(
        'Network target requires a config file with a "pipeline.network" section ' +
          '(scope, ad, scanners, relay, cracking, safety, attack_framework).',
        'config',
        false,
        {},
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }

  const config = await parseConfig(configPath);
  if (!config.pipeline?.network) {
    return err(
      new PentestError(
        'Network target requires a "pipeline.network" section in the config file. ' +
          'At minimum: engagement_mode, scope.targets, ad.enabled, scanners.vuln_scanner, ' +
          'relay.enabled, cracking.enabled/budget_minutes/compute, safety.*, attack_framework.attack_version.',
        'config',
        false,
        {},
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }

  const net = config.pipeline.network;

  // Cross-field checks the JSON schema can't express
  if (net.scanners.vuln_scanner === 'nessus' && !net.scanners.nessus_license_env) {
    return err(
      new PentestError(
        'pipeline.network.scanners.vuln_scanner = "nessus" requires nessus_license_env (the env var name holding the license key).',
        'config',
        false,
        {},
        ErrorCode.CONFIG_VALIDATION_FAILED
      )
    );
  }

  if (net.relay.enabled && net.relay.network_mode === 'bridge') {
    logger.warn(
      'pipeline.network.relay.enabled = true with network_mode = "bridge" — multicast traffic ' +
        '(LLMNR/NBT-NS/mDNS) will not reach Responder/mitm6. Use network_mode: "host" for working relay.'
    );
  }

  if (net.safety.coercion_authorized && net.safety.avoid_production_dcs) {
    logger.warn(
      'pipeline.network.safety: coercion_authorized = true AND avoid_production_dcs = true — coercion ' +
        'primitives (PetitPotam/DFSCoerce/PrinterBug) will be skipped because avoid_production_dcs takes precedence.'
    );
  }

  logger.info('Network prerequisites OK', {
    engagement_mode: net.engagement_mode,
    target_count: net.scope.targets.length,
    ad_enabled: net.ad.enabled,
    vuln_scanner: net.scanners.vuln_scanner,
    relay_enabled: net.relay.enabled,
    cracking_compute: net.cracking.compute,
  });
  return ok(undefined);
}

// === Preflight Orchestrator ===

/**
 * Run all preflight checks sequentially (cheapest first).
 *
 * 1. Repository folder layout matches `pipelineMode` (skipped for mobile/api):
 *    - whitebox → non-empty `{repoPath}/src/`
 *    - graybox  → non-empty `{repoPath}/docs/`
 *    - network  → non-empty `{repoPath}/docs/` (same as graybox; project docs grounding)
 * 2. Config file parses and validates (if configPath provided)
 * 3. Target-specific prerequisites (mobile or network)
 * 4. Credentials validate (API key, OAuth, or router mode)
 *
 * Returns on first failure.
 */
export async function runPreflightChecks(
  repoPath: string,
  configPath: string | undefined,
  logger: ActivityLogger,
  target: PipelineTarget = 'web',
  pipelineMode: PipelineMode = 'graybox'
): Promise<Result<void, PentestError>> {
  // 1. Repository check (skipped for mobile/api — workspace is auto-created)
  if (target !== 'mobile' && target !== 'api') {
    const repoResult = await validateRepo(repoPath, logger, pipelineMode);
    if (!repoResult.ok) {
      return repoResult;
    }
  }

  // 2. Config check (free — filesystem + CPU)
  if (configPath) {
    const configResult = await validateConfig(configPath, logger);
    if (!configResult.ok) {
      return configResult;
    }
  }

  // 3. Target-specific prerequisites
  if (target === 'mobile') {
    const mobileResult = await validateMobilePrerequisites(configPath, logger);
    if (!mobileResult.ok) {
      return mobileResult;
    }
  } else if (target === 'network') {
    const networkResult = await validateNetworkPrerequisites(configPath, logger);
    if (!networkResult.ok) {
      return networkResult;
    }
  }

  // 4. Credential check (cheap — 1 SDK round-trip)
  const credResult = await validateCredentials(logger);
  if (!credResult.ok) {
    return credResult;
  }

  logger.info('All preflight checks passed');
  return ok(undefined);
}
