import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { chatService } from '../services/chat-service.js';
import { getAvailableSkills } from '../services/opencode-skill-discovery.js';

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

    // Backend-aware discovery (U7): live sessions use their own runtime;
    // new OpenCode chats use only OpenCode-compatible filesystem skills.
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const requestedBackend = typeof req.query.backend === 'string' ? req.query.backend : undefined;
    if (sessionId) {
      const session = workspaceStore.getLocalSession(sessionId);
      if (session?.backend === 'opencode' || session?.backend === 'codex') {
        const commands = await chatService.getSessionBackendCommands(sessionId);
        // Same envelope as the claude path so clients never read undefined
        // for fields the other backend always sends (review P2).
        res.json({ commands, partial: false });
        return;
      }
    }
    if (requestedBackend === 'opencode') {
      const commands = await getAvailableSkills(workspace.folderPath);
      res.json({ commands, partial: false });
      return;
    }
    if (requestedBackend === 'codex') {
      res.json({ commands: [], partial: false });
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
