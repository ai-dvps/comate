import { Router } from 'express';
import { execSync } from 'child_process';
import { store as workspaceStore } from '../storage/sqlite-store.js';

const router = Router({ mergeParams: true });

function getGitRef(folderPath: string): string | null {
  const opts = {
    cwd: folderPath,
    stdio: 'pipe' as const,
    timeout: 5000,
    encoding: 'utf-8' as const,
  };

  try {
    const branch = execSync('git symbolic-ref --short HEAD', opts).trim();
    if (branch) return branch;
  } catch {
    // not on a branch
  }

  try {
    const tag = execSync('git describe --tags --exact-match', opts).trim();
    if (tag) return tag;
  } catch {
    // not on an exact tag
  }

  try {
    const sha = execSync('git rev-parse --short HEAD', opts).trim();
    if (sha) return sha;
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

    const ref = getGitRef(workspace.folderPath);
    res.json({ ref });
  } catch (error) {
    console.error('Failed to get git ref:', error);
    res.status(500).json({ error: 'Failed to get git ref' });
  }
});

export default router;
