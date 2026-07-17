import { Router } from 'express';
import { execFile } from 'child_process';
import { realpath, lstat } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { diagWarn } from '../utils/diag-logger.js';

const execFileAsync = promisify(execFile);

const router = Router({ mergeParams: true });

export interface GitStatusItem {
  path: string;
  indexStatus: string;
  workingTreeStatus: string;
  originalPath?: string;
}

const MAX_DIFF_SIZE = 500 * 1024;
const MAX_DIFF_LINES = 5000;

function parsePorcelainLine(line: string): GitStatusItem {
  if (line.length < 4) {
    return { path: line, indexStatus: '?', workingTreeStatus: '?' };
  }

  const indexStatus = line[0] ?? '?';
  const workingTreeStatus = line[1] ?? '?';
  const rest = line.slice(3);

  if (indexStatus === 'R' || workingTreeStatus === 'R') {
    const arrowIndex = rest.indexOf(' -> ');
    if (arrowIndex !== -1) {
      return {
        path: rest.slice(arrowIndex + 4),
        indexStatus,
        workingTreeStatus,
        originalPath: rest.slice(0, arrowIndex),
      };
    }
  }

  return { path: rest, indexStatus, workingTreeStatus };
}

export function parsePorcelainStatus(stdout: string): GitStatusItem[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parsePorcelainLine);
}

async function runGitStatus(folderPath: string): Promise<GitStatusItem[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      {
        cwd: folderPath,
        timeout: 10000,
        encoding: 'utf-8',
      },
    );
    return parsePorcelainStatus(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not a git repository')) {
      return [];
    }
    throw error;
  }
}

async function resolveAndValidatePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string | null> {
  const resolvedBase = await realpath(path.resolve(workspaceRoot));
  const resolvedRequested = path.resolve(resolvedBase, requestedPath);

  if (
    resolvedRequested !== resolvedBase &&
    !resolvedRequested.startsWith(resolvedBase + path.sep)
  ) {
    return null;
  }

  // Reject paths that resolve through symlinks outside the workspace, and
  // reject symlinked files themselves.
  let current = resolvedRequested;
  while (current !== resolvedBase) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const linkTarget = await realpath(current);
        if (
          linkTarget !== resolvedBase &&
          !linkTarget.startsWith(resolvedBase + path.sep)
        ) {
          return null;
        }
      }
      break;
    } catch {
      current = path.dirname(current);
      if (
        current !== resolvedBase &&
        !current.startsWith(resolvedBase + path.sep)
      ) {
        return null;
      }
    }
  }

  // Also verify the realpath of the resolved file (or its deepest existing
  // ancestor for deleted files) stays inside the workspace.
  try {
    const realResolved = await realpath(resolvedRequested);
    if (
      realResolved !== resolvedBase &&
      !realResolved.startsWith(resolvedBase + path.sep)
    ) {
      return null;
    }
  } catch {
    try {
      const realParent = await realpath(path.dirname(resolvedRequested));
      if (
        realParent !== resolvedBase &&
        !realParent.startsWith(resolvedBase + path.sep)
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return resolvedRequested;
}

function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length > MAX_DIFF_SIZE) {
    return { diff: diff.slice(0, MAX_DIFF_SIZE), truncated: true };
  }
  const lines = diff.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    return { diff: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
  }
  return { diff, truncated: false };
}

function isBinaryDiff(output: string): boolean {
  return output.includes('Binary files ') && output.includes(' differ');
}

// GET /api/workspaces/:id/git-changes
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }

    const items = await runGitStatus(workspace.folderPath);
    res.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-changes] failed to get status:', message);
    res.status(500).json({ error: 'Failed to get git status' });
  }
});

// GET /api/workspaces/:id/git-changes/diff?path=&staged=
router.get('/diff', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }

    const relativePath = req.query.path;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const targetPath = await resolveAndValidatePath(workspace.folderPath, relativePath);
    if (!targetPath) {
      res.status(403).json({ error: 'Path outside workspace' });
      return;
    }

    const staged = req.query.staged === 'true' || req.query.staged === '1';
    const args = staged
      ? ['diff', '--cached', '--no-color', '--', relativePath]
      : ['diff', '--no-color', '--', relativePath];

    const { stdout } = await execFileAsync('git', args, {
      cwd: workspace.folderPath,
      timeout: 30000,
      encoding: 'utf-8',
    });

    if (isBinaryDiff(stdout)) {
      res.json({ diff: stdout, isBinary: true, truncated: false });
      return;
    }

    const { diff, truncated } = capDiff(stdout);
    res.json({ diff, isBinary: false, truncated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-changes] failed to get diff:', message);
    res.status(500).json({ error: 'Failed to get git diff' });
  }
});

export default router;

// Exposed for tests that need to validate porcelain parsing without git.
export { parsePorcelainLine };
