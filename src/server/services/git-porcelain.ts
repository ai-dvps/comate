import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitStatusItem } from '../models/git-changes.js';

const execFileAsync = promisify(execFile);

const NOT_A_GIT_REPO_MARKER = 'not a git repository';

/** True when a git error indicates the folder is not a git worktree. */
export function isNotAGitRepoError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(NOT_A_GIT_REPO_MARKER);
}

/**
 * Parse `git status --porcelain=v1 -z` output. The `-z` form emits paths
 * verbatim (no `core.quotepath` octal escaping) and NUL-terminates every
 * record; rename/copy records carry the original path as a second
 * NUL-terminated token immediately after the new path. This correctly handles
 * non-ASCII filenames (CJK, accented Latin, etc.), which the previous
 * newline-split parser turned into quoted strings the client then sent back
 * as unreachable filesystem paths.
 */
export function parsePorcelainStatus(stdout: string): GitStatusItem[] {
  if (stdout.length === 0) return [];
  const tokens = stdout.split('\0');
  const items: GitStatusItem[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) continue;
    if (token.length < 3) {
      items.push({ path: token, indexStatus: '?', workingTreeStatus: '?' });
      continue;
    }
    const indexStatus = token[0] ?? '?';
    const workingTreeStatus = token[1] ?? '?';
    const filePath = token.slice(3);
    const isRenameOrCopy =
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      workingTreeStatus === 'R' ||
      workingTreeStatus === 'C';
    if (isRenameOrCopy) {
      const originalPath = tokens[i + 1];
      items.push({
        path: filePath,
        indexStatus,
        workingTreeStatus,
        originalPath:
          originalPath !== undefined && originalPath.length > 0 ? originalPath : undefined,
      });
      // Consume the original-path token that follows a rename/copy record.
      i += 1;
    } else {
      items.push({ path: filePath, indexStatus, workingTreeStatus });
    }
  }
  return items;
}

/**
 * Run `git status` in NUL-delimited (`-z`) form so non-ASCII and special
 * characters in paths are emitted verbatim. Throws on any git error
 * (including "not a git repository"); callers decide tolerance via
 * {@link isNotAGitRepoError}.
 */
export async function runGitStatus(folderPath: string): Promise<GitStatusItem[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: folderPath, timeout: 10000, encoding: 'utf-8' },
  );
  return parsePorcelainStatus(stdout);
}
