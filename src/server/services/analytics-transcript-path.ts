/**
 * Resolve Claude Agent SDK transcript paths on disk (see plan 2026-06-13-007, U2).
 *
 * Transcripts live at `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * The encoding MUST match the SDK's byte-for-byte or the resolved path points
 * at a directory that never exists and analytics silently stays empty (the
 * Windows regression fixed here — comate originally replaced only `/`, `\`,
 * and `:`, while the SDK replaces every non-alphanumeric character).
 *
 * The SDK pipeline (sdk.mjs `Fz`/`jn` → `Fo`, config dir `Xt`):
 *   1. `path.resolve(dir)` — strip trailing separators, resolve relatives
 *   2. `realpathSync(...)` with fallback to the unresolved path
 *   3. NFC normalize on darwin
 *   4. replace EVERY `[^a-zA-Z0-9]` with `-`
 *   5. if longer than 200 chars: truncate to 200 and append
 *      `-${Math.abs(javaHash(preEncodingPath)).toString(36)}`
 *   6. config dir = `CLAUDE_CONFIG_DIR` ?? `~/.claude`, NFC-normalized
 *
 * Verified end-to-end against the real SDK: `listSessions({dir})` finds a
 * transcript only under the directory produced by this exact pipeline.
 */

import { existsSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';

import { getHomeCandidates } from '../utils/home-dir.js';

/** Max encoded project-dir length before truncation kicks in (SDK `Ss`). */
const MAX_PROJECT_DIR_LENGTH = 200;

/**
 * Java-style string hash rendered base36 — mirrors the SDK's `gv`/`$9` used
 * for the long-path suffix. Must match exactly or workspace paths whose
 * encoded name exceeds 200 chars won't resolve.
 */
function hashProjectPath(preEncodingPath: string): string {
  let h = 0;
  for (let i = 0; i < preEncodingPath.length; i++) {
    h = ((h << 5) - h + preEncodingPath.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Encode a workspace path into the directory name Claude Code uses under
 * `<config>/projects/`. Mirrors the SDK's `Fo`: EVERY non-alphanumeric
 * character becomes `-` — not just path separators and the Windows drive
 * colon, but also dots, spaces, underscores, and CJK characters (all common
 * in Windows user/profile paths). Names longer than 200 chars are truncated
 * with a `-<base36 hash>` suffix.
 *
 * Pure: callers must canonicalize first via `resolveProjectPath` (the SDK
 * encodes the realpath-resolved path, not the raw input).
 */
export function encodeProjectDir(folderPath: string): string {
  const encoded = folderPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_PROJECT_DIR_LENGTH) return encoded;
  return `${encoded.slice(0, MAX_PROJECT_DIR_LENGTH)}-${hashProjectPath(folderPath)}`;
}

/**
 * Canonicalize a workspace path the way the SDK does before encoding
 * (`Fz`/`jn`): `path.resolve` → `realpathSync` (fallback to the unresolved
 * path when it doesn't exist) → NFC normalize on darwin. Without this,
 * symlinked or non-canonical workspace paths encode to a different directory
 * than the one Claude Code actually created.
 */
export function resolveProjectPath(folderPath: string): string {
  const resolved = resolve(folderPath);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === 'darwin' ? canonical.normalize('NFC') : canonical;
}

/**
 * Resolve the projects root directory (`<config>/projects`). Honors
 * `CLAUDE_CONFIG_DIR` when set to a non-empty value — mirroring the SDK's
 * config-dir resolution (`Xt`: `CLAUDE_CONFIG_DIR ?? ~/.claude`). An explicit
 * env var declares where Claude Code actually writes; falling back to
 * `~/.claude/projects` in that case would read transcripts from the wrong
 * installation. Two deliberate deviations from Xt:
 *   - an EMPTY CLAUDE_CONFIG_DIR is treated as unset: Xt's `??` would adopt
 *     it verbatim, yielding a cwd-relative `projects` root that is
 *     meaningless for this long-lived server process (whose cwd differs from
 *     the Claude child process's workspace cwd);
 *   - without it, picks the first `~/.claude/projects` that exists under the
 *     home candidates (shared cascade in `src/server/utils/home-dir.ts`) —
 *     existence is the strongest signal there since env vars can lag a home
 *     directory move.
 * Like Xt, the result is NFC-normalized on every platform.
 */
export function resolveClaudeProjectsDir(): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) return join(configDir, 'projects').normalize('NFC');
  for (const home of getHomeCandidates()) {
    const projectsDir = join(home, '.claude', 'projects').normalize('NFC');
    if (existsSync(projectsDir)) return projectsDir;
  }
  return null;
}

/**
 * Resolve the transcript directory for a workspace:
 * `<config>/projects/<encoded-cwd>/`. The cwd is canonicalized
 * (`resolveProjectPath`) before encoding, exactly like the SDK. Returns null
 * when the projects root cannot be located.
 */
export function resolveTranscriptDir(folderPath: string): string | null {
  const projectsDir = resolveClaudeProjectsDir();
  if (!projectsDir) return null;
  return join(projectsDir, encodeProjectDir(resolveProjectPath(folderPath)));
}

/**
 * Stat a transcript file. Returns `{ exists: false }` when missing so callers
 * can branch without try/catch around statSync.
 */
export function statTranscript(
  filePath: string,
): { exists: true; mtimeMs: number; size: number } | { exists: false } {
  try {
    const stat = statSync(filePath);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}
