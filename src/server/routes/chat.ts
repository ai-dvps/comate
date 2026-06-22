import { Router } from 'express';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { chatService, ChatError } from '../services/chat-service.js';
import { store } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

const router = Router({ mergeParams: true });
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

// GET /api/workspaces/:id/sessions/status
// Lightweight status check for background session discovery
router.get('/sessions/status', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const statuses = chatService.getSessionsStatus(workspaceId);
    res.json({ statuses });
  } catch (error) {
    console.error('Failed to get sessions status:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to get sessions status' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/messages
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { messages, tasks, subagents } = await chatService.loadMessages(sessionId, workspaceId, offset, limit);
    res.json({ messages, tasks, subagents });
  } catch (error) {
    console.error('Failed to load messages:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/messages/latest
// Returns messages newer than a given message ID
router.get('/sessions/:sessionId/messages/latest', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const afterMessageId = req.query.afterMessageId as string | undefined;
    const { messages, tasks, subagents } = await chatService.loadMessagesAfter(sessionId, workspaceId, afterMessageId);
    res.json({ messages, tasks, subagents });
  } catch (error) {
    console.error('Failed to load latest messages:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to load latest messages' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/wecom-user
// Returns WeCom user info for bot sessions
router.get('/sessions/:sessionId/wecom-user', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const encryptedUserId = store.getWecomUserIdBySession(workspaceId, sessionId);
    if (!encryptedUserId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const mapping = store.getWecomUserMapping(encryptedUserId);
    const workspaceUser = store.getWecomWorkspaceUser(workspaceId, encryptedUserId);
    res.json({
      userId: mapping ?? encryptedUserId,
      lastSeenAt: workspaceUser?.lastSeenAt ?? null,
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
    const openId = store.getFeishuSessionOwner(workspaceId, sessionId);
    if (!openId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const workspaceUser = store.getFeishuWorkspaceUser(workspaceId, openId);
    res.json({
      userId: workspaceUser?.name ?? workspaceUser?.userId ?? openId,
      name: workspaceUser?.name ?? null,
      lastSeenAt: workspaceUser?.lastSeenAt ?? null,
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

// GET /api/workspaces/:id/sessions/:sessionId/stream
// Long-lived SSE subscription for streaming output
router.get('/sessions/:sessionId/stream', async (req, res) => {
  const sessionId = req.params.sessionId;
  const workspaceId = (req.params as unknown as { id: string }).id;
  diagLog(`[Route] GET /sessions/${sessionId}/stream`);

  try {
    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);
    diagLog(`[Route] got runtime for ${sessionId}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const lastEventId = req.headers['last-event-id'] as string | undefined;

    runtime.subscribe(res, lastEventId);

    req.on('close', () => {
      diagLog(`[Route] req close for ${sessionId}`);
      runtime.unsubscribe(res);
    });
  } catch (error) {
    console.error('Failed to subscribe to stream:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to subscribe to stream' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/messages
// Push a user message into the session's input channel
router.post('/sessions/:sessionId/messages', async (req, res) => {
  const sessionId = req.params.sessionId;
  const workspaceId = (req.params as unknown as { id: string }).id;
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    diagLog(`[Route] POST message to ${sessionId}`);
    await chatService.pushMessage(sessionId, workspaceId, message);
    res.json({ ok: true, debug: `[Route] POST message to ${sessionId}` });
  } catch (error) {
    console.error('Failed to push message:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to push message' });
  }
});

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
  const workspaceId = (req.params as unknown as { id: string }).id;
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

export default router;
