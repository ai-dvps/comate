import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { wecomUserResolver } from '../services/wecom-user-resolver.js';
import { chatService } from '../services/chat-service.js';
import { SAFE_PRESET } from '../services/tool-permission-policy.js';
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

    // Detect the wecomBotEnabled false→true transition. When a workspace newly
    // enables the bot, apply the safe preset to its tool-permission policy if no
    // policy is set yet. This satisfies R6/AE3 ("safe preset is applied
    // automatically") regardless of whether the request originated from the UI
    // or a non-UI caller (curl, scripts, future API consumers).
    const prior = await store.get(req.params.id);
    const wasEnabled = !!prior?.settings.wecomBotEnabled;
    const willEnable = !!input.settings?.wecomBotEnabled;
    const hasPolicy = !!(
      input.settings?.wecomToolPermissions ||
      prior?.settings.wecomToolPermissions
    );
    if (!wasEnabled && willEnable && !hasPolicy) {
      input.settings = {
        ...(input.settings || {}),
        wecomToolPermissions: SAFE_PRESET,
      };
    }

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

    // Evict any cached bot runtimes for this workspace so they do not keep
    // answering inbound messages against a workspace whose settings row is gone.
    await chatService.closeRuntimesForWorkspace(req.params.id);

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

// GET /api/workspaces/:id/prompt-history
// Returns the workspace's sent-prompt history, pruning entries older than the
// configured retention threshold first.
router.get('/:id/prompt-history', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const retentionDays = workspace.settings?.promptHistoryRetentionDays ?? 30;
    if (retentionDays > 0) {
      store.prunePromptHistory(req.params.id, retentionDays as number);
    }

    const prompts = store.listPromptHistory(req.params.id);
    res.json({ prompts });
  } catch (error) {
    console.error('Failed to list prompt history:', error);
    res.status(500).json({ error: 'Failed to list prompt history' });
  }
});

// POST /api/workspaces/:id/prompt-history
// Records a user-sent prompt in the workspace-scoped history log.
router.post('/:id/prompt-history', async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const { sessionId, prompt } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const trimmed = prompt.trim();
    if (!trimmed) {
      res.status(400).json({ error: 'prompt cannot be empty' });
      return;
    }

    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const entry = store.createPromptHistory(workspaceId, sessionId, trimmed);
    res.status(201).json(entry);
  } catch (error) {
    console.error('Failed to create prompt history:', error);
    res.status(500).json({ error: 'Failed to create prompt history' });
  }
});

export default router;
