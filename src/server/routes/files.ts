import { Router } from 'express';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { store } from '../storage/sqlite-store.js';

const router = Router({ mergeParams: true });

interface FileNode {
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

async function validatePath(workspacePath: string, requestedPath: string): Promise<string | null> {
  const resolvedBase = path.resolve(workspacePath);
  const resolvedRequested = path.resolve(resolvedBase, requestedPath);

  // Ensure the resolved path is within the workspace folder
  if (!resolvedRequested.startsWith(resolvedBase)) {
    return null;
  }

  return resolvedRequested;
}

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
