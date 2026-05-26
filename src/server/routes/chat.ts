import { Router } from 'express';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { chatService, ChatError } from '../services/chat-service.js';
import { diagLog } from '../utils/diag-logger.js';

const router = Router({ mergeParams: true });
diagLog('[Route] chat module loaded');

// GET /api/workspaces/:id/sessions
router.get('/sessions', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const sessions = await chatService.listSessions(workspaceId);
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
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const session = await chatService.createSession({ workspaceId, name });
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
    const { name, isWip } = req.body;

    const hasName = name !== undefined && typeof name === 'string' && name.trim() !== '';
    const hasWip = isWip !== undefined && typeof isWip === 'boolean';

    if (!hasName && !hasWip) {
      res.status(400).json({ error: 'name or isWip is required' });
      return;
    }

    const input: { name?: string; isWip?: boolean } = {};
    if (hasName) input.name = name.trim();
    if (hasWip) input.isWip = isWip;

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
    const { messages, tasks } = await chatService.loadMessages(sessionId, workspaceId, offset, limit);
    res.json({ messages, tasks });
  } catch (error) {
    console.error('Failed to load messages:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to load messages' });
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
    const runtime = await chatService.getOrCreateRuntime(sessionId, workspaceId);
    runtime.pushMessage(message);
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

export default router;
