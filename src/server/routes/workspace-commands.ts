import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { chatService } from '../services/chat-service.js';

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

    // Backend-aware discovery (U7): an opencode session's commands come from
    // its own serve; without a live serve the list is empty rather than
    // claude-flavored (builtins differ between runtimes).
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    if (sessionId) {
      const session = workspaceStore.getLocalSession(sessionId);
      if (session?.backend === 'opencode') {
        const commands = await chatService.getSessionBackendCommands(sessionId);
        res.json({ commands });
        return;
      }
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
