/**
 * Resolve Claude Agent SDK transcript paths on disk (see plan 2026-06-13-007, U2).
 *
 * Transcripts live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` where
 * `<encoded-cwd>` is the workspace `folderPath` with every path separator
 * (`/` or `\`) replaced by `-`. Verified against the on-disk layout:
 * `/Users/shunyun/workspace/ai/claude-code-gui` encodes to
 * `-Users-shunyun-workspace-ai-claude-code-gui`. This matches the reference
 * app and the SDK's own layout convention.
 *
 * The probe during planning confirmed that direct JSONL reads are required for
 * analytics — the SDK accessor returns only the live post-compaction view.
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Encode a workspace folderPath into the directory name Claude Code uses under
 * `~/.claude/projects/`. Every `/`, `\`, or Windows drive-letter `:` becomes `-`.
 */
export function encodeProjectDir(folderPath: string): string {
  return folderPath.replace(/[/\\:]/g, '-');
}

/**
 * Return the list of plausible `~` candidates in resolution order. Mirrors the
 * multi-candidate home resolution already used in
 * `src/server/utils/claude-settings.ts` so analytics honors the same env
 * overrides (USERPROFILE on Windows, HOMEDRIVE+HOMEPATH, HOME, homedir()).
 */
function getHomeCandidates(): string[] {
  const candidates = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined,
    homedir(),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

/**
 * Resolve the projects root directory (`~/.claude/projects`). Returns the first
 * candidate path that exists on disk, or null when none exists. We pick by
 * existence because that's the strongest signal — env vars can lag a home
 * directory move.
 */
export function resolveClaudeProjectsDir(): string | null {
  for (const home of getHomeCandidates()) {
    const projectsDir = join(home, '.claude', 'projects');
    if (existsSync(projectsDir)) return projectsDir;
  }
  return null;
}

/**
 * Resolve the transcript directory for a workspace:
 * `~/.claude/projects/<encoded-cwd>/`. Returns null when the projects root
 * cannot be located (no .claude/projects under any home candidate).
 */
export function resolveTranscriptDir(folderPath: string): string | null {
  const projectsDir = resolveClaudeProjectsDir();
  if (!projectsDir) return null;
  return join(projectsDir, encodeProjectDir(folderPath));
}

/**
 * Resolve the absolute transcript file path for a session.
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Returns null when the
 * projects root cannot be located. Use `statTranscript` to check existence
 * and read mtime atomically.
 */
export function resolveTranscriptFile(
  folderPath: string,
  sessionId: string,
): string | null {
  const dir = resolveTranscriptDir(folderPath);
  if (!dir) return null;
  return join(dir, `${sessionId}.jsonl`);
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
