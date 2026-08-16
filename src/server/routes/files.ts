import { Router } from 'express';
import { realpath, readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { store } from '../storage/sqlite-store.js';
import { searchFiles } from '../services/file-search.js';
import { sidecarError } from '../utils/sidecar-logger.js';

const router = Router({ mergeParams: true });

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_RESOLVE_PATHS = 64;
const MAX_RESOLVE_PATH_LENGTH = 4096;
const MAX_RESOLVE_PATH_TEXT = 64 * 1024;

function isWithinWorkspace(workspacePath: string, requestedPath: string): boolean {
  return requestedPath === workspacePath || requestedPath.startsWith(`${workspacePath}${path.sep}`);
}

async function validatePathFromResolvedBase(
  resolvedBase: string,
  requestedPath: string,
): Promise<string | null> {
  const requestedCandidate = path.resolve(resolvedBase, requestedPath);

  if (!isWithinWorkspace(resolvedBase, requestedCandidate)) {
    return null;
  }

  const resolvedRequested = await realpath(requestedCandidate);
  if (!isWithinWorkspace(resolvedBase, resolvedRequested)) {
    return null;
  }

  return resolvedRequested;
}

async function validatePath(workspacePath: string, requestedPath: string): Promise<string | null> {
  return validatePathFromResolvedBase(await realpath(workspacePath), requestedPath);
}

function parseResolvePaths(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || !('paths' in body)) return null;
  const paths = (body as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || paths.some((candidate) => typeof candidate !== 'string')) {
    return null;
  }

  const uniquePaths = [...new Set(paths as string[])];
  if (
    uniquePaths.length > MAX_RESOLVE_PATHS ||
    uniquePaths.some((candidate) => candidate.length > MAX_RESOLVE_PATH_LENGTH) ||
    uniquePaths.reduce((total, candidate) => total + candidate.length, 0) > MAX_RESOLVE_PATH_TEXT
  ) {
    return null;
  }
  return uniquePaths;
}

// POST /api/workspaces/:id/files/resolve
router.post('/resolve', async (req, res) => {
  try {
    const workspace = await store.get((req.params as { id: string }).id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const candidates = parseResolvePaths(req.body);
    if (!candidates) {
      res.status(400).json({ error: 'Invalid paths request' });
      return;
    }

    const resolvedBase = await realpath(workspace.folderPath);
    const existing: string[] = [];
    for (const candidate of candidates) {
      if (!candidate || candidate.includes('\0') || path.isAbsolute(candidate)) continue;
      try {
        const resolved = await validatePathFromResolvedBase(resolvedBase, candidate);
        if (resolved && (await stat(resolved)).isFile()) {
          existing.push(candidate);
        }
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          continue;
        }
        throw error;
      }
    }

    res.json({ paths: existing });
  } catch (error) {
    sidecarError('[files/resolve] failed:', error instanceof Error ? (error.stack || error.message) : error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to resolve files' });
    }
  }
});

// GET /api/workspaces/:id/files/search?q=&limit=
router.get('/search', async (req, res) => {
  try {
    const workspace = await store.get((req.params as { id: string }).id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;

    const controller = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await searchFiles({
        workspaceRoot: workspace.folderPath,
        query,
        limit,
        signal: controller.signal,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Client disconnected; nothing to send.
        return;
      }
      throw err;
    }
  } catch (error) {
    sidecarError('[files/search] failed:', error instanceof Error ? (error.stack || error.message) : error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to search files' });
    }
  }
});

// GET /api/workspaces/:id/files?path=
router.get('/', async (req, res) => {
  try {
    const workspace = await store.get((req.params as { id: string }).id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const relativePath = (req.query.path as string) || '';
    const targetPath = await validatePath(workspace.folderPath, relativePath);

    if (!targetPath) {
      res.status(403).json({ error: 'Path outside workspace' });
      return;
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const nodes: FileNode[] = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
    }));

    // Sort: folders first, then files, both alphabetically
    nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'folder' ? -1 : 1;
    });

    res.json({ path: relativePath, nodes });
  } catch (error) {
    console.error('Failed to list files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// GET /api/workspaces/:id/files/content?path=
router.get('/content', async (req, res) => {
  try {
    const workspace = await store.get((req.params as { id: string }).id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const relativePath = req.query.path as string;
    if (!relativePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const targetPath = await validatePath(workspace.folderPath, relativePath);

    if (!targetPath) {
      res.status(403).json({ error: 'Path outside workspace' });
      return;
    }

    const fileStat = await stat(targetPath);
    if (!fileStat.isFile()) {
      res.status(400).json({ error: 'Not a file' });
      return;
    }

    const mimeType = IMAGE_MIME_TYPES[path.extname(targetPath).toLowerCase()];
    if (mimeType) {
      if (fileStat.size > MAX_IMAGE_PREVIEW_BYTES) {
        res.json({
          path: relativePath,
          content: null,
          mimeType,
          isBinary: true,
          size: fileStat.size,
          previewUnavailable: 'too_large',
        });
        return;
      }

      const buffer = await readFile(targetPath);
      res.json({
        path: relativePath,
        content: buffer.toString('base64'),
        encoding: 'base64',
        mimeType,
        isBinary: true,
        size: fileStat.size,
      });
      return;
    }

    // Check if binary (simple heuristic: check for null bytes in first 8KB)
    const buffer = await readFile(targetPath);
    const sample = buffer.slice(0, 8192);
    const isBinary = sample.includes(0);

    if (isBinary) {
      res.json({
        path: relativePath,
        content: null,
        isBinary: true,
        size: fileStat.size
      });
      return;
    }

    const content = buffer.toString('utf-8');
    res.json({ path: relativePath, content, isBinary: false, size: fileStat.size });
  } catch (error) {
    console.error('Failed to read file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

export default router;
