// Copyright (C) 2026 TECHVIFY
//
// This file is part of Gandalf, a fork of Shannon Lite by Keygraph, Inc.
// (https://github.com/KeygraphHQ/shannon). It is released under the
// GNU Affero General Public License version 3, the same license as the
// upstream project. See LICENSE and NOTICE.md at the repository root.

/**
 * Auth Map Aggregator Service
 *
 * Concatenates per-persona auth-mapper deliverables into the canonical
 * `graybox_auth_map.md` consumed by downstream vuln, exploit, and report
 * agents.
 *
 * The save_deliverable MCP tool writes a single hardcoded filename, so
 * parallel persona runs race-overwrite the canonical map. Each persona also
 * writes a suffixed copy under `deliverables/auth/graybox_auth_map_<persona>.md`;
 * this aggregator merges those into a single canonical file.
 *
 * No Temporal dependencies — pure domain logic.
 */

import path from 'path';
import fs from 'fs/promises';
import type { ActivityLogger } from '../types/activity-logger.js';
import { atomicWrite } from '../utils/file-io.js';

const PERSONA_SUBDIR = 'auth';
const PERSONA_FILE_PREFIX = 'graybox_auth_map_';
const PERSONA_FILE_SUFFIX = '.md';
const CANONICAL_FILENAME = 'graybox_auth_map.md';

export interface AggregateResult {
  outputPath: string;
  personasMerged: number;
  personas: string[];
}

/**
 * Read all per-persona auth maps under {workspacePath}/deliverables/auth/
 * and concatenate them into {workspacePath}/deliverables/graybox_auth_map.md.
 *
 * Idempotent. If no per-persona files exist (single-persona runs, or before
 * the auth-mapper has produced anything), the canonical file is left
 * untouched and the function returns with personasMerged: 0.
 */
export async function aggregatePersonaAuthMaps(
  workspacePath: string,
  logger: ActivityLogger
): Promise<AggregateResult> {
  const deliverablesDir = path.join(workspacePath, 'deliverables');
  const personaDir = path.join(deliverablesDir, PERSONA_SUBDIR);
  const outputPath = path.join(deliverablesDir, CANONICAL_FILENAME);

  // 1. Enumerate per-persona files
  const personaFiles = await findPersonaFiles(personaDir, logger);
  if (personaFiles.length === 0) {
    return { outputPath, personasMerged: 0, personas: [] };
  }

  // 2. Read each file and build a section per persona
  const sections: string[] = [];
  const personas: string[] = [];

  for (const filename of personaFiles) {
    const persona = filename.slice(
      PERSONA_FILE_PREFIX.length,
      filename.length - PERSONA_FILE_SUFFIX.length
    );
    const filePath = path.join(personaDir, filename);
    const content = await fs.readFile(filePath, 'utf8');

    sections.push(formatSection(persona, filename, content));
    personas.push(persona);
  }

  // 3. Concatenate with a top-level header and write atomically
  const merged = formatHeader(personas) + sections.join('\n---\n\n');
  await atomicWrite(outputPath, merged);

  logger.info(
    `Aggregated ${personaFiles.length} persona auth map(s) into ${CANONICAL_FILENAME}`,
    { personas, outputPath }
  );

  return { outputPath, personasMerged: personaFiles.length, personas };
}

async function findPersonaFiles(
  personaDir: string,
  logger: ActivityLogger
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(personaDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(`Persona auth dir missing — skipping aggregation: ${personaDir}`);
      return [];
    }
    throw error;
  }

  const matches = entries
    .filter(
      (name) =>
        name.startsWith(PERSONA_FILE_PREFIX) && name.endsWith(PERSONA_FILE_SUFFIX)
    )
    .sort();

  if (matches.length === 0) {
    logger.warn(`No per-persona auth maps found under ${personaDir}`);
  }

  return matches;
}

function formatHeader(personas: string[]): string {
  return [
    '# Gray-Box Auth Map (Aggregated)',
    '',
    `Merged from ${personas.length} persona file(s): ${personas.join(', ')}.`,
    '',
    '---',
    '',
    '',
  ].join('\n');
}

function formatSection(persona: string, filename: string, content: string): string {
  return [
    `# Persona: ${persona}`,
    '',
    `Source: \`deliverables/auth/${filename}\``,
    '',
    content.trim(),
    '',
  ].join('\n');
}
