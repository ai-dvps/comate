import { Router } from 'express';
import { execFile } from 'child_process';
import { realpath, lstat, readFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { diagWarn } from '../utils/diag-logger.js';
import type { GitStatusItem } from '../models/git-changes.js';
import { runGitStatus, isNotAGitRepoError } from '../services/git-porcelain.js';

const execFileAsync = promisify(execFile);

const router = Router({ mergeParams: true });

const MAX_DIFF_SIZE = 500 * 1024;
const MAX_DIFF_LINES = 5000;

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

function containsNullByte(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function capContent(buffer: Buffer): { content: string; truncated: boolean } {
  let truncated = false;
  let working = buffer;
  if (working.length > MAX_DIFF_SIZE) {
    working = working.slice(0, MAX_DIFF_SIZE);
    truncated = true;
  }
  const text = working.toString('utf-8');
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    return { content: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated: true };
  }
  return { content: text, truncated };
}

async function detectBinary(
  folderPath: string,
  relativePath: string,
  staged: boolean,
  originalBuffer: Buffer,
  modifiedBuffer: Buffer,
): Promise<boolean> {
  const args = staged
    ? ['diff', '--cached', '--numstat', '--no-color', '--', relativePath]
    : ['diff', '--numstat', '--no-color', '--', relativePath];
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: folderPath,
      timeout: 30000,
      encoding: 'utf-8',
    });
    const firstLine = stdout.split('\n').find((line) => line.length > 0);
    if (firstLine) {
      const parts = firstLine.split('\t');
      if (parts.length >= 2 && parts[0] === '-' && parts[1] === '-') {
        return true;
      }
      return false;
    }
  } catch {
    // Fall through to null-byte scanning.
  }
  return containsNullByte(originalBuffer) || containsNullByte(modifiedBuffer);
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

    let items: GitStatusItem[];
    try {
      items = await runGitStatus(workspace.folderPath);
    } catch (error) {
      // A non-git folder is legitimately "no changes"; any other failure
      // falls through to the 500 handler below.
      if (isNotAGitRepoError(error)) {
        items = [];
      } else {
        throw error;
      }
    }
    res.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-changes] failed to get status:', message);
    res.status(500).json({ error: 'Failed to get git status' });
  }
});

// GET /api/workspaces/:id/git-changes/compare?path=&staged=
router.get('/compare', async (req, res) => {
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

    // The client sends the rename source as `originalPath` when present, so
    // honor it directly instead of spawning a second `git status` to look it
    // up. Fall back to the requested path when the client has no rename.
    const originalPathQuery =
      typeof req.query.originalPath === 'string' && req.query.originalPath.length > 0
        ? req.query.originalPath
        : undefined;
    const originalRelativePath = originalPathQuery ?? relativePath;

    const [originalResult, modifiedResult] = await Promise.all([
      execFileAsync('git', ['show', `HEAD:${originalRelativePath}`], {
        cwd: workspace.folderPath,
        timeout: 30000,
        encoding: 'buffer',
      }).then(
        ({ stdout }) => ({ buffer: stdout as Buffer, isDeleted: false }),
        () => ({ buffer: Buffer.alloc(0), isDeleted: false }),
      ),
      staged
        ? execFileAsync('git', ['show', `:0:${relativePath}`], {
            cwd: workspace.folderPath,
            timeout: 30000,
            encoding: 'buffer',
          }).then(
            ({ stdout }) => ({ buffer: stdout as Buffer, isDeleted: false }),
            () => ({ buffer: Buffer.alloc(0), isDeleted: true }),
          )
        : readFile(targetPath)
            .then((buffer) => ({ buffer, isDeleted: false }))
            .catch((error) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { buffer: Buffer.alloc(0), isDeleted: true };
              }
              throw error;
            }),
    ]);

    const originalBuffer = originalResult.buffer;
    const modifiedBuffer = modifiedResult.buffer;
    const isDeleted = modifiedResult.isDeleted;

    const isBinary = await detectBinary(
      workspace.folderPath,
      relativePath,
      staged,
      originalBuffer,
      modifiedBuffer,
    );

    let original = '';
    let modified = '';
    let truncated = false;
    if (!isBinary) {
      const originalCapped = capContent(originalBuffer);
      const modifiedCapped = capContent(modifiedBuffer);
      original = originalCapped.content;
      modified = modifiedCapped.content;
      truncated = originalCapped.truncated || modifiedCapped.truncated;
    }

    res.json({ original, modified, isBinary, truncated, isDeleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-changes] failed to get compare:', message);
    res.status(500).json({ error: 'Failed to get git compare' });
  }
});

export default router;
