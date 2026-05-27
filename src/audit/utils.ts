// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Audit System Utilities
 *
 * Core utility functions for path generation, atomic writes, and formatting.
 * All functions are pure and crash-safe.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { ensureDirectory } from '../utils/file-io.js';

export type { SessionMetadata } from '../types/audit.js';
import type { SessionMetadata } from '../types/audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get Gandalf repository root
const GANDALF_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_LOGS_DIR = path.join(GANDALF_ROOT, 'audit-logs');

/**
 * Extract and sanitize hostname from URL for use in identifiers
 */
export function sanitizeHostname(url: string): string {
  return new URL(url).hostname.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Generate standardized session identifier from workflow ID
 * Workflow IDs already contain hostname, so we use them directly
 */
export function generateSessionIdentifier(sessionMetadata: SessionMetadata): string {
  return sessionMetadata.id;
}

/**
 * Generate path to audit log directory for a session
 * Uses custom outputPath if provided, otherwise defaults to AUDIT_LOGS_DIR
 */
export function generateAuditPath(sessionMetadata: SessionMetadata): string {
  const sessionIdentifier = generateSessionIdentifier(sessionMetadata);
  const baseDir = sessionMetadata.outputPath || AUDIT_LOGS_DIR;
  return path.join(baseDir, sessionIdentifier);
}

/**
 * Generate path to agent log file
 */
export function generateLogPath(
  sessionMetadata: SessionMetadata,
  agentName: string,
  timestamp: number,
  attemptNumber: number
): string {
  const auditPath = generateAuditPath(sessionMetadata);
  const filename = `${timestamp}_${agentName}_attempt-${attemptNumber}.log`;
  return path.join(auditPath, 'agents', filename);
}

/**
 * Generate path to prompt snapshot file. When `personaName` is provided the
 * filename is suffixed (`<agent>_<persona>.md`) so per-persona fan-outs of the
 * same agent (e.g. auth-mapper running once per persona) don't race on a
 * shared `<agent>.md.tmp` rename inside `atomicWrite`.
 */
export function generatePromptPath(
  sessionMetadata: SessionMetadata,
  agentName: string,
  personaName?: string
): string {
  const auditPath = generateAuditPath(sessionMetadata);
  const filename = personaName ? `${agentName}_${personaName}.md` : `${agentName}.md`;
  return path.join(auditPath, 'prompts', filename);
}

/**
 * Generate path to session.json file
 */
export function generateSessionJsonPath(sessionMetadata: SessionMetadata): string {
  const auditPath = generateAuditPath(sessionMetadata);
  return path.join(auditPath, 'session.json');
}

/**
 * Generate path to workflow.log file
 */
export function generateWorkflowLogPath(sessionMetadata: SessionMetadata): string {
  const auditPath = generateAuditPath(sessionMetadata);
  return path.join(auditPath, 'workflow.log');
}

/**
 * Initialize audit directory structure for a session
 * Creates: audit-logs/{sessionId}/, agents/, prompts/, deliverables/
 */
export async function initializeAuditStructure(sessionMetadata: SessionMetadata): Promise<void> {
  const auditPath = generateAuditPath(sessionMetadata);
  const agentsPath = path.join(auditPath, 'agents');
  const promptsPath = path.join(auditPath, 'prompts');
  const deliverablesPath = path.join(auditPath, 'deliverables');

  await ensureDirectory(auditPath);
  await ensureDirectory(agentsPath);
  await ensureDirectory(promptsPath);
  await ensureDirectory(deliverablesPath);
}

/**
 * Copy deliverable files from the agent's workspace to audit-logs for a
 * self-contained audit trail. No-ops if source directory doesn't exist, or if
 * source and destination resolve to the same path (the common case now that
 * workspacePath lives under ./audit-logs/<sessionId>/). Idempotent and
 * parallel-safe.
 */
export async function copyDeliverablesToAudit(
  sessionMetadata: SessionMetadata,
  workspacePath: string
): Promise<void> {
  const sourceDir = path.join(workspacePath, 'deliverables');
  const destDir = path.join(generateAuditPath(sessionMetadata), 'deliverables');

  // Fast path: deliverables already live in the audit directory.
  if (path.resolve(sourceDir) === path.resolve(destDir)) {
    return;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    // Source directory doesn't exist yet — nothing to copy
    return;
  }

  await ensureDirectory(destDir);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const destPath = path.join(destDir, entry);

    // Only copy files, skip subdirectories
    const stat = await fs.stat(sourcePath);
    if (stat.isFile()) {
      await fs.copyFile(sourcePath, destPath);
    }
  }
}
