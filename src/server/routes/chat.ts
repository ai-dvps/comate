import { Router } from 'express';
import { chatService, ChatError } from '../services/chat-service.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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

interface ClientMessage {
  type: string;
  data?: unknown;
}

function formatMessage(msg: SDKMessage): ClientMessage | null {
  switch (msg.type) {
    case 'assistant': {
      const content = msg.message.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && b.text) {
            text += b.text;
          }
        }
      }
      return { type: 'assistant', data: { text, uuid: msg.uuid } };
    }
    case 'stream_event': {
      const event = (msg.event as unknown) as Record<string, unknown>;
      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          return { type: 'text_delta', data: { text: delta.text } };
        }
      }
      return null;
    }
    case 'tool_progress':
      return {
        type: 'tool_progress',
        data: {
          toolName: msg.tool_name,
          elapsedTime: msg.elapsed_time_seconds,
        },
      };
    case 'result':
      return {
        type: 'result',
        data: {
          subtype: msg.subtype,
          isError: msg.is_error,
          result: msg.subtype === 'success' ? msg.result : undefined,
          errors: 'errors' in msg ? msg.errors : undefined,
        },
      };
    case 'system': {
      if (msg.subtype === 'init') {
        return {
          type: 'system_init',
          data: {
            model: msg.model,
            tools: msg.tools,
            sessionId: msg.session_id,
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function sendSSE(res: import('express').Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

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

    for await (const msg of stream.messages) {
      if (clientClosed) break;

      const formatted = formatMessage(msg);
      if (formatted) {
        sendSSE(res, formatted.type, formatted.data);
      }
    }

    if (!clientClosed) {
      sendSSE(res, 'done', {});
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
      sendSSE(res, 'error', { message: 'Stream failed' });
      res.end();
    } else {
      res.status(500).json({ error: 'Chat stream failed' });
    }
  }
});

export default router;
