import { Router } from 'express';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { chatService, ChatError } from '../services/chat-service.js';
import { store } from '../storage/sqlite-store.js';
import { botService } from '../services/bot-service.js';
import { diagLog } from '../utils/diag-logger.js';
import type { BotUser } from '../models/bot-user.js';
import { loadWorkflowState, listWorkflowRunIds } from '../services/workflow-loader.js';

const router = Router({ mergeParams: true });
const WORKFLOW_ID_RE = /^[a-zA-Z0-9_-]+$/;
diagLog('[Route] chat module loaded');

// GET /api/workspaces/:id/sessions
router.get('/sessions', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const rawThreshold = req.query.archive_threshold_days;
    const parsedThreshold = typeof rawThreshold === 'string' && rawThreshold !== ''
      ? parseInt(rawThreshold, 10)
      : NaN;
    const archiveThresholdDays = !isNaN(parsedThreshold) && parsedThreshold > 0
      ? parsedThreshold
      : undefined;

    const sessions = await chatService.listSessions(workspaceId, { archiveThresholdDays });
    res.json({ sessions });
  } catch (error) {
    console.error('Failed to list sessions:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// POST /api/workspaces/:id/sessions
router.post('/sessions', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const { name, approvalMode, providerId } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (approvalMode !== undefined && !['auto', 'readonly', 'manual'].includes(approvalMode)) {
      res.status(400).json({ error: 'approvalMode must be one of: auto, readonly, manual' });
      return;
    }

    const session = await chatService.createSession({ workspaceId, name, approvalMode, providerId });
    res.status(201).json(session);
  } catch (error) {
    console.error('Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// PUT /api/workspaces/:id/sessions/:sessionId
router.put('/sessions/:sessionId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const { name, isWip, providerId, isArchived } = req.body;

    const hasName = name !== undefined && typeof name === 'string' && name.trim() !== '';
    const hasWip = isWip !== undefined && typeof isWip === 'boolean';
    const hasProviderId = providerId !== undefined;
    const hasArchived = isArchived !== undefined && typeof isArchived === 'boolean';

    if (!hasName && !hasWip && !hasProviderId && !hasArchived) {
      res.status(400).json({ error: 'name, isWip, providerId, or isArchived is required' });
      return;
    }

    const input: { name?: string; isWip?: boolean; providerId?: string; isArchived?: boolean } = {};
    if (hasName) input.name = name.trim();
    if (hasWip) input.isWip = isWip;
    if (hasProviderId) input.providerId = providerId;
    if (hasArchived) input.isArchived = isArchived;

    const session = await chatService.updateSession(sessionId, input, workspaceId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(session);
  } catch (error) {
    console.error('Failed to update session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// DELETE /api/workspaces/:id/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    // Unlink any todo tied to this session before deleting
    store.unlinkTodoBySessionId(sessionId);
    const success = await chatService.deleteSession(sessionId, workspaceId);
    if (!success) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/fork
// Fork an existing session into a new branched session
router.post('/sessions/:sessionId/fork', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const result = await chatService.forkSession(sessionId, workspaceId);
    res.status(201).json(result);
  } catch (error) {
    console.error('Failed to fork session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to fork session' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/wecom-user
// Returns WeCom user info for bot sessions
router.get('/sessions/:sessionId/wecom-user', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const user = findChannelUserForSession(workspaceId, 'wecom', sessionId);
    if (!user) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      userId: user.plaintextUserId ?? user.channelUserId,
    });
  } catch (error) {
    console.error('Failed to get WeCom user:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to get WeCom user' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/feishu-user
// Returns Feishu user info for bot sessions
router.get('/sessions/:sessionId/feishu-user', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const user = findChannelUserForSession(workspaceId, 'feishu', sessionId);
    if (!user) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      userId: user.plaintextUserId ?? user.channelUserId,
      name: user.plaintextUserId ?? null,
    });
  } catch (error) {
    console.error('Failed to get Feishu user:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to get Feishu user' });
  }
});

function findChannelUserForSession(
  workspaceId: string,
  channelKey: 'wecom' | 'feishu',
  sessionId: string,
): BotUser | null {
  const users = botService.listChannelUsersForWorkspace(workspaceId, channelKey);
  for (const user of users) {
    const sessions = store.listUserSessionsByUser(user.id);
    if (sessions.some((s) => s.sessionId === sessionId)) {
      return user;
    }
  }
  return null;
}

// POST /api/workspaces/:id/sessions/:sessionId/approvals/:requestId
// Resolve a pending approval or question
router.post('/sessions/:sessionId/approvals/:requestId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const requestId = req.params.requestId;
  const workspaceId = (req.params as unknown as { id: string }).id;
  const { behavior, updatedPermissions, answers } = req.body;

  if (!behavior || (behavior !== 'allow' && behavior !== 'deny')) {
    res.status(400).json({ error: "behavior must be 'allow' or 'deny'" });
    return;
  }

  try {
    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);

    let result: PermissionResult;
    if (behavior === 'allow') {
      if (answers) {
        // AskUserQuestion response
        result = {
          behavior: 'allow',
          updatedInput: { questions: req.body.questions, answers },
        };
      } else {
        result = { behavior: 'allow', updatedPermissions };
      }
    } else {
      result = {
        behavior: 'deny',
        message: req.body.message || 'User denied this tool call.',
      };
    }

    diagLog(`[Route] resolveApproval ${requestId} behavior=${behavior}`);
    runtime.resolveApproval(requestId, result);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to resolve approval:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to resolve approval' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/interrupt
// Interrupt the current turn
router.post('/sessions/:sessionId/interrupt', async (req, res) => {
  const sessionId = req.params.sessionId;
  const workspaceId = (req.params as unknown as { id: string }).id;

  try {
    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);
    await runtime.interrupt();
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to interrupt:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to interrupt' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/approval-mode
// Change the approval mode for a session (mid-session or persist for next start)
router.post('/sessions/:sessionId/approval-mode', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { approvalMode } = req.body;

  if (!approvalMode || !['auto', 'readonly', 'manual'].includes(approvalMode)) {
    res.status(400).json({ error: 'approvalMode must be one of: auto, readonly, manual' });
    return;
  }

  try {
    // Persist to store so it survives restart
    store.updateLocalSession(sessionId, { approvalMode });

    // If runtime is active, update it in-memory
    const runtime = chatService.getRuntimeIfExists(sessionId);
    const active = !!runtime;
    if (runtime) {
      runtime.setApprovalMode(approvalMode);
    }

    diagLog(`[Route] setApprovalMode sessionId=${sessionId} mode=${approvalMode} active=${active}`);
    res.json({ ok: true, active });
  } catch (error) {
    console.error('Failed to set approval mode:', error);
    res.status(500).json({ error: 'Failed to set approval mode' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/workflows
// List workflow runIds that have on-disk state for this session.
router.get('/sessions/:sessionId/workflows', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    if (!WORKFLOW_ID_RE.test(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }
    const localSession = store.getLocalSession(sessionId);
    if (!localSession || localSession.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runIds = await listWorkflowRunIds(workspace.folderPath, sessionId);
    res.json({ runIds });
  } catch (error) {
    console.error('Failed to list workflows:', error);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/workflows/:runId
// Read the on-disk workflow state for a specific run.
router.get('/sessions/:sessionId/workflows/:runId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const runId = req.params.runId;
    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    if (!WORKFLOW_ID_RE.test(sessionId) || !WORKFLOW_ID_RE.test(runId)) {
      res.status(400).json({ error: 'Invalid sessionId or runId' });
      return;
    }
    const localSession = store.getLocalSession(sessionId);
    if (!localSession || localSession.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const workflow = await loadWorkflowState({ folderPath: workspace.folderPath, sessionId, runId });
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json({ workflow });
  } catch (error) {
    console.error('Failed to load workflow:', error);
    res.status(500).json({ error: 'Failed to load workflow' });
  }
});

export default router;
