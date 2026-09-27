/**
 * Atomic skills-lock file reader/writer.
 *
 * Reads and writes both lock file schemas with POSIX-rename atomicity:
 *   - Project lock: `<workspace>/skills-lock.json` (version 1, sorted alphabetically)
 *   - Global lock: `~/.agents/.skill-lock.json` (version 3, insertion order)
 *
 * The atomic write pattern is ported from
 * `src/server/utils/claude-settings.ts:273-301`:
 *   1. Write to `${path}.tmp`
 *   2. Rename original to `${path}.bak` (if it exists)
 *   3. Rename `${path}.tmp` → `${path}`
 *   4. Delete `${path}.bak` on success
 *   5. On failure: restore `${path}.bak` → `${path}` (if the original was lost)
 *
 * This guarantees the lock file on disk is either the OLD content or the
 * NEW content — never a partial write. POSIX `rename` is atomic; on Windows
 * the same semantics hold for `renameSync` when source and dest share a
 * filesystem (which is guaranteed because we use sibling `.tmp`/`.bak` names).
 *
 * Schema parsing & path resolution live in the adapter at
 * `src/server/services/skills/skill-lock-adapter.ts`. This module composes
 * those parsers with atomic write semantics.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  readProjectLock as parseProjectLock,
  readGlobalLock as parseGlobalLock,
  serializeProjectLock,
  serializeGlobalLock,
  getProjectLockPath,
  getGlobalLockPath,
} from '../services/skills/skill-lock-adapter.js';
import type { LocalSkillLockFile, GlobalSkillLockFile } from '../services/skills/types.js';

// Re-export path helpers for callers (e.g., SkillsService in U4)
export { getProjectLockPath, getGlobalLockPath } from '../services/skills/skill-lock-adapter.js';

// ---------------------------------------------------------------------------
// Project lock (version 1, alphabetical sort on write)
// ---------------------------------------------------------------------------

/**
 * Read and parse the project lock file. NEVER throws — returns the empty
 * default on missing/corrupt/old-version files. Mirrors upstream behavior.
 */
export async function readProjectLock(workspacePath: string): Promise<LocalSkillLockFile> {
  return parseProjectLock(workspacePath);
}

/**
 * Atomically write the project lock file. Skills are sorted alphabetically
 * for deterministic output and minimal merge conflicts when committed.
 *
 * @throws if the write fails (atomic guarantee: original content restored)
 */
export async function writeProjectLock(
  workspacePath: string,
  lock: LocalSkillLockFile
): Promise<void> {
  const lockPath = getProjectLockPath(workspacePath);
  const content = serializeProjectLock(lock);
  await atomicWrite(lockPath, content);
}

// ---------------------------------------------------------------------------
// Global lock (version 3, insertion order preserved)
// ---------------------------------------------------------------------------

/**
 * Read and parse the global lock file. NEVER throws.
 */
export async function readGlobalLock(): Promise<GlobalSkillLockFile> {
  return parseGlobalLock();
}

/**
 * Atomically write the global lock file. Insertion order is preserved
 * (the file is not committed, so no merge-conflict pressure to sort).
 *
 * @throws if the write fails (atomic guarantee: original content restored)
 */
export async function writeGlobalLock(lock: GlobalSkillLockFile): Promise<void> {
  const lockPath = getGlobalLockPath();
  const content = serializeGlobalLock(lock);
  await atomicWrite(lockPath, content);
}

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors claude-settings.ts:273-301)
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath` atomically.
 *
 * Algorithm:
 *   1. Ensure parent directory exists.
 *   2. Write content to `${filePath}.tmp`.
 *   3. If `${filePath}` exists, rename it to `${filePath}.bak`.
 *   4. Rename `${filePath}.tmp` to `${filePath}`.
 *   5. Delete `${filePath}.bak`.
 *
 * On failure at step 4: attempt to restore `${filePath}.bak` → `${filePath}`
 * so the file is never left missing.
 *
 * POSIX `rename` is atomic, so any external reader sees either the old
 * file or the new file — never a partial write.
 */
function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;

  return new Promise((resolve, reject) => {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 1. Write temp file with new content
      writeFileSync(tempPath, content, 'utf-8');

      // 2. Backup original (if present)
      if (existsSync(filePath)) {
        renameSync(filePath, backupPath);
      }

      // 3. Promote temp to final
      try {
        renameSync(tempPath, filePath);
      } catch (promoteErr) {
        // Restore backup if promotion failed and original existed
        try {
          if (existsSync(backupPath) && !existsSync(filePath)) {
            renameSync(backupPath, filePath);
          }
        } catch {
          // ignore restore error — best effort
        }
        throw promoteErr;
      }

      // 4. Clean up backup on success
      if (existsSync(backupPath)) {
        try {
          unlinkSync(backupPath);
        } catch {
          // ignore cleanup error — best effort
        }
      }

      resolve();
    } catch (err) {
      // Cleanup any lingering temp file
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // ignore cleanup error
      }
      reject(err);
    }
  });
}

// Re-export serializers for tests +SkillsService direct use
export { serializeProjectLock, serializeGlobalLock } from '../services/skills/skill-lock-adapter.js';
