import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { store as workspaceStore } from '../storage/sqlite-store.js';

const execAsync = promisify(exec);

const router = Router({ mergeParams: true });

async function getGitRef(folderPath: string): Promise<string | null> {
  const opts = {
    cwd: folderPath,
    timeout: 5000,
    encoding: 'utf-8' as const,
  };

  try {
    const { stdout: branch } = await execAsync('git symbolic-ref --short HEAD', opts);
    if (branch.trim()) return branch.trim();
  } catch {
    // not on a branch
  }

  try {
    const { stdout: tag } = await execAsync('git describe --tags --exact-match', opts);
    if (tag.trim()) return tag.trim();
  } catch {
    // not on an exact tag
  }

  try {
    const { stdout: sha } = await execAsync('git rev-parse --short HEAD', opts);
    if (sha.trim()) return sha.trim();
  } catch {
    // not a git repo or git unavailable
  }

  return null;
}

// GET /api/workspaces/:id/git-ref
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res
        .status(404)
        .json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }

    const ref = await getGitRef(workspace.folderPath);
    res.json({ ref });
  } catch (error) {
    console.error('Failed to get git ref:', error);
    res.status(500).json({ error: 'Failed to get git ref' });
  }
});

export default router;
