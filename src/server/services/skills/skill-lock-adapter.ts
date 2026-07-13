/**
 * Lock-file schema parsing & path resolution.
 *
 * Reimplemented from `src/server/vendor/vercel-skills/src/skill-lock.ts` and
 * `src/server/vendor/vercel-skills/src/local-lock.ts`. The upstream modules
 * are mostly pure (fs/path/crypto deps), but `skill-lock.ts` imports
 * `picocolors`, `execSync` for the GitHub tree SHA machinery, and a dynamic
 * `import('./blob.ts')` — all of which we strip. We compute `skillFolderHash`
 * locally from installed files instead of via the GitHub Trees API.
 *
 * This module handles SCHEMA + PATH only. Atomic WRITE lives in
 * `src/server/utils/skills-lock.ts` (U3) which composes these parsers
 * with the temp-file + rename + backup pattern from `claude-settings.ts:273-301`.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { getPrimaryHomeDir } from '../../utils/home-dir.js';
import type {
  GlobalSkillLockFile,
  GlobalSkillLockEntry,
  LocalSkillLockFile,
  LocalSkillLockEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Project lock file (version 1, no dot prefix, lives at workspace root)
// ---------------------------------------------------------------------------

export const PROJECT_LOCK_FILENAME = 'skills-lock.json';
export const PROJECT_LOCK_CURRENT_VERSION = 1;

/**
 * Resolve the project lock file path.
 * Upstream uses `process.cwd()` as default; Comate requires an explicit
 * workspace path because the sidecar is long-lived and CWD is unstable.
 */
export function getProjectLockPath(workspacePath: string): string {
  return join(workspacePath, PROJECT_LOCK_FILENAME);
}

/**
 * Read and parse a project lock file. NEVER throws — returns the empty
 * default if the file is missing, corrupt, or an unrecognized version.
 *
 * The returned object is always a fresh copy — callers can mutate freely
 * before passing to `writeProjectLock` (which lives in U3).
 */
export async function readProjectLock(
  workspacePath: string
): Promise<LocalSkillLockFile> {
  const lockPath = getProjectLockPath(workspacePath);
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as LocalSkillLockFile;

    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyProjectLock();
    }
    if (parsed.version < PROJECT_LOCK_CURRENT_VERSION) {
      // Old version: wipe (matches upstream behavior — fresh install repopulates)
      return createEmptyProjectLock();
    }
    return parsed;
  } catch {
    return createEmptyProjectLock();
  }
}

function createEmptyProjectLock(): LocalSkillLockFile {
  return { version: PROJECT_LOCK_CURRENT_VERSION, skills: {} };
}

/**
 * Returns a sorted-deep-copy of `lock` for deterministic JSON output.
 * Project lock sorts skills alphabetically (matches upstream, minimizes
 * merge conflicts when the file is committed).
 */
export function serializeProjectLock(lock: LocalSkillLockFile): string {
  const sorted: Record<string, LocalSkillLockEntry> = {};
  for (const key of Object.keys(lock.skills).sort()) {
    sorted[key] = lock.skills[key]!;
  }
  return JSON.stringify({ version: lock.version, skills: sorted }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Global lock file (version 3, dot prefix, lives at ~/.agents/)
// ---------------------------------------------------------------------------

export const GLOBAL_LOCK_DIRNAME = '.agents';
export const GLOBAL_LOCK_FILENAME = '.skill-lock.json';
export const GLOBAL_LOCK_CURRENT_VERSION = 3;

/**
 * Resolve the global lock file path.
 *
 * Mirrors upstream: honor `$XDG_STATE_HOME/skills/.skill-lock.json` if set,
 * otherwise `~/.agents/.skill-lock.json`.
 *
 * HOME resolution uses the shared cascade from
 * `src/server/utils/home-dir.ts` ($USERPROFILE → $HOME → HOMEDRIVE+HOMEPATH
 * → `os.homedir()`), which matters under Tauri where env propagation may be
 * incomplete.
 */
export function getGlobalLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'skills', GLOBAL_LOCK_FILENAME);
  }
  return join(getPrimaryHomeDir(), GLOBAL_LOCK_DIRNAME, GLOBAL_LOCK_FILENAME);
}

/**
 * Read and parse the global lock file. NEVER throws — returns the empty
 * default if the file is missing, corrupt, or an unrecognized version.
 */
export async function readGlobalLock(): Promise<GlobalSkillLockFile> {
  const lockPath = getGlobalLockPath();
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as GlobalSkillLockFile;

    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyGlobalLock();
    }
    if (parsed.version < GLOBAL_LOCK_CURRENT_VERSION) {
      // Old version: wipe (matches upstream — v3 adds skillFolderHash, fresh
      // installs repopulate. We never migrate silently.)
      return createEmptyGlobalLock();
    }
    return parsed;
  } catch {
    return createEmptyGlobalLock();
  }
}

function createEmptyGlobalLock(): GlobalSkillLockFile {
  return { version: GLOBAL_LOCK_CURRENT_VERSION, skills: {}, dismissed: {} };
}

/**
 * Returns deterministic JSON for `lock`. Global lock preserves insertion
 * order (matches upstream — we do not sort global entries because the file
 * is not committed and there is no merge-conflict pressure).
 */
export function serializeGlobalLock(lock: GlobalSkillLockFile): string {
  return JSON.stringify(lock, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Entry construction helpers (used by SkillsService in U4)
// ---------------------------------------------------------------------------

/**
 * Build a project-scope lock entry. Caller provides the computed hash;
 * we just enforce the schema.
 */
export function buildProjectLockEntry(args: {
  source: string;
  sourceType: string;
  computedHash: string;
  ref?: string;
  skillPath?: string;
}): LocalSkillLockEntry {
  return {
    source: args.source,
    sourceType: args.sourceType,
    computedHash: args.computedHash,
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.skillPath ? { skillPath: args.skillPath } : {}),
  };
}

/**
 * Build a global-scope lock entry. Caller provides timestamps so the
 * service can preserve `installedAt` on updates.
 */
export function buildGlobalLockEntry(args: {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  ref?: string;
  skillPath?: string;
  pluginName?: string;
}): GlobalSkillLockEntry {
  return {
    source: args.source,
    sourceType: args.sourceType,
    sourceUrl: args.sourceUrl,
    skillFolderHash: args.skillFolderHash,
    installedAt: args.installedAt,
    updatedAt: args.updatedAt,
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.skillPath ? { skillPath: args.skillPath } : {}),
    ...(args.pluginName ? { pluginName: args.pluginName } : {}),
  };
}
