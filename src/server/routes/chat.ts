import { Router } from 'express';
import { chatService, ChatError } from '../services/chat-service.js';
import { SseEmitter } from '../services/sse-emitter.js';

const router = Router({ mergeParams: true });

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

// DELETE /api/workspaces/:id/sessions/:sessionId
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const deleted = await chatService.deleteSession(req.params.sessionId, workspaceId);
    if (!deleted) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete session:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// GET /api/workspaces/:id/sessions/:sessionId/messages
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const sessionId = req.params.sessionId;
    const messages = await chatService.loadMessages(sessionId, workspaceId);
    res.json({ messages });
  } catch (error) {
    console.error('Failed to load messages:', error);
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /api/workspaces/:id/sessions/:sessionId/chat
router.post('/sessions/:sessionId/chat', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const stream = await chatService.sendMessage(sessionId, message);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let clientClosed = false;
    req.on('close', () => {
      clientClosed = true;
      stream.rawQuery.interrupt().catch(() => {});
    });

    const emitter = new SseEmitter(res);

    for await (const msg of stream.messages) {
      if (clientClosed) break;
      emitter.handle(msg);
    }

    if (!clientClosed) {
      emitter.done();
    }

    res.end();

    // After stream completes, clear draft flag if this was a draft session
    if (stream.wasDraft) {
      chatService.clearDraftFlag(sessionId).catch((err) => {
        console.error('Failed to clear draft flag:', err);
      });
    }
  } catch (error) {
    if (error instanceof ChatError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }

    console.error('Chat stream error:', error);

    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      const emitter = new SseEmitter(res);
      emitter.error('Stream failed');
      res.end();
    } else {
      res.status(500).json({ error: 'Chat stream failed' });
    }
  }
});

export default router;
