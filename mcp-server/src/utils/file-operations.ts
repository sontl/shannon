// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * File Operations Utilities
 *
 * Handles file system operations for deliverable saving.
 * Ported from tools/save_deliverable.js (lines 117-130).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Save deliverable file under the workspace's deliverables/ directory.
 *
 * @param targetDir - Workspace root (deliverables/ is created beneath it)
 * @param filename - Path relative to deliverables/ (may include subdirs, e.g. `auth/foo.md`)
 * @param content - File content to save
 */
export function saveDeliverableFile(targetDir: string, filename: string, content: string): string {
  const deliverablesDir = join(targetDir, 'deliverables');
  const filepath = join(deliverablesDir, filename);

  // Create the parent directory of the target file (covers subdirs like `auth/`)
  try {
    mkdirSync(dirname(filepath), { recursive: true });
  } catch {
    throw new Error(`Cannot create directory for ${filepath}`);
  }

  writeFileSync(filepath, content, 'utf8');

  return filepath;
}
