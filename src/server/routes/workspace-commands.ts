import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';

const router = Router({ mergeParams: true });

// GET /api/workspaces/:id/commands
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

    const result = await commandsService.getCommands(workspace);
    res.json({
      commands: result.commands,
      partial: result.partial,
      partialReason: result.partialReason,
    });
  } catch (error) {
    console.error('Failed to fetch commands:', error);
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

export default router;
