import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { wecomUserResolver } from '../services/wecom-user-resolver.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';

const router = Router();

// GET /api/workspaces
router.get('/', async (_req, res) => {
  try {
    const workspaces = await store.list();
    res.json({ workspaces });
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// POST /api/workspaces
router.post('/', async (req, res) => {
  try {
    const input = req.body as CreateWorkspaceInput;

    if (!input.name || !input.folderPath) {
      res.status(400).json({ error: 'name and folderPath are required' });
      return;
    }

    const workspace = await store.create(input);
    res.status(201).json({ workspace });
  } catch (error) {
    console.error('Failed to create workspace:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// GET /api/workspaces/:id
router.get('/:id', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ workspace });
  } catch (error) {
    console.error('Failed to get workspace:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// PUT /api/workspaces/:id
router.put('/:id', async (req, res) => {
  try {
    const input = req.body as UpdateWorkspaceInput;
    const workspace = await store.update(req.params.id, input);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Manage bot connection based on updated settings
    const enabled = workspace.settings.wecomBotEnabled;
    const hasCredentials = workspace.settings.wecomBotId && workspace.settings.wecomBotSecret;
    if (enabled && hasCredentials) {
      wecomBotService.connect(workspace);
    } else {
      wecomBotService.disconnect(workspace.id);
    }

    res.json({ workspace });
  } catch (error) {
    console.error('Failed to update workspace:', error);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// GET /api/workspaces/:id/bot/status
router.get('/:id/bot/status', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const status = wecomBotService.getStatus(req.params.id);
    res.json({ status });
  } catch (error) {
    console.error('Failed to get bot status:', error);
    res.status(500).json({ error: 'Failed to get bot status' });
  }
});

// DELETE /api/workspaces/:id
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await store.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

// GET /api/workspaces/:id/wecom/users
router.get('/:id/wecom/users', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const users = store.listWecomWorkspaceUsers(req.params.id);
    const mappings = store.listWecomUserMappings();
    const mappingMap = new Map(mappings.map((m) => [m.encryptedUserId, m.plaintextUserId]));

    const result = users.map((u) => ({
      encryptedUserId: u.encryptedUserId,
      plaintextUserId: mappingMap.get(u.encryptedUserId) || undefined,
      firstSeenAt: u.firstSeenAt,
      lastSeenAt: u.lastSeenAt,
    }));

    res.json({ users: result });
  } catch (error) {
    console.error('Failed to list WeCom workspace users:', error);
    res.status(500).json({ error: 'Failed to list WeCom workspace users' });
  }
});

// GET /api/workspaces/:id/wecom/resolver-status
router.get('/:id/wecom/resolver-status', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const status = wecomUserResolver.getStatus();
    const wsQueue = status.workspaceQueues.find((q) => q.workspaceId === req.params.id);

    res.json({
      initialized: status.initialized,
      queueDepth: wsQueue?.depth ?? 0,
      inFlightTokenRefresh: status.inFlightRefreshes > 0,
      lastFlushAt: status.lastFlushAt,
    });
  } catch (error) {
    console.error('Failed to get resolver status:', error);
    res.status(500).json({ error: 'Failed to get resolver status' });
  }
});

export default router;
