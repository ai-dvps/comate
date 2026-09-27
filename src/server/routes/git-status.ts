import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { gitGraphService } from '../services/git-graph-service.js';

const router = Router({ mergeParams: true });

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

    const capability = await gitGraphService.getCapability(workspace.folderPath);
    res.json(capability);
  } catch (error) {
    console.error('Failed to get git ref:', error);
    res.status(500).json({ error: 'Failed to get git ref' });
  }
});

export default router;
