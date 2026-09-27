import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { botService } from '../services/bot-service.js';
import { requireSessionAuth } from '../services/security/loopback-auth.js';
import type { BotUser } from '../models/bot-user.js';

const router = Router({ mergeParams: true });

// POST /api/workspaces/:workspaceId/wecom/send
router.post('/', async (req, res) => {
  try {
    // U12 (KTD-28): identity comes from the session capability token, never
    // from a self-asserted sessionId. The loopback-auth middleware has
    // already bound the token to this workspace.
    const auth = requireSessionAuth(req, res);
    if (!auth) return;
    const sessionId = auth.sessionId;

    const workspaceId = (req.params as { workspaceId: string }).workspaceId;
    const { sessionId: assertedSessionId, toUser, message } = req.body as {
      sessionId?: string;
      toUser?: string;
      message?: string;
      msgType?: 'text' | 'markdown';
    };

    // A mismatched self-asserted sessionId is rejected loudly (a confused or
    // malicious caller must not silently act as the bound session).
    if (assertedSessionId !== undefined && assertedSessionId !== sessionId) {
      res.status(403).json({ error: 'session_mismatch', message: 'sessionId does not match the authenticated session.' });
      return;
    }
    if (!toUser || typeof toUser !== 'string' || toUser.trim().length === 0) {
      res.status(400).json({ error: 'toUser is required' });
      return;
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const callerUser = findWecomUserForSession(workspaceId, sessionId);
    const callerPlaintextUserId = callerUser?.plaintextUserId ?? null;

    // Same user + bot connected → direct send. On direct-send failure (including bot
    // not connected), surface the error instead of silently re-enqueueing, which would
    // create an infinite loop.
    if (callerPlaintextUserId === toUser.trim()) {
      const status = wecomBotService.getStatus(workspaceId);
      if (status === 'connected') {
        try {
          await wecomBotService.sendDirectMessage(workspaceId, toUser.trim(), message.trim());
          res.status(200).json({ method: 'direct', sent: true });
          return;
        } catch (error) {
          console.error(`[WeComSend] Direct send failed for workspace ${workspaceId}:`, error);
          const message = error instanceof Error ? error.message : 'Direct send failed';
          res.status(500).json({ error: 'direct_send_failed', message });
          return;
        }
      }

      res.status(503).json({
        error: 'bot_not_connected',
        message: 'WeCom bot is not connected for this workspace. Please reconnect the bot and retry.',
      });
      return;
    }

    // Different user, unmapped session, or bot not connected → enqueue
    const recipientUser = findWecomUserByPlaintext(workspaceId, toUser.trim());
    if (!recipientUser) {
      res.status(400).json({
        error: 'recipient_not_resolved',
        message: 'WeCom user ID has not been decrypted yet. The recipient must send at least one message to the bot first.',
      });
      return;
    }

    const recipientSessionId = store.getActiveUserSession(recipientUser.id);
    if (!recipientSessionId) {
      res.status(400).json({
        error: 'recipient_no_session',
        message: 'Recipient has no active session in this workspace.',
      });
      return;
    }

    const entry = store.enqueueProactiveMessage(workspaceId, {
      senderSessionId: sessionId,
      recipientEncryptedUserId: recipientUser.channelUserId,
      recipientPlaintextUserId: toUser.trim(),
      messageContent: message.trim(),
    });

    res.status(202).json({ method: 'queued', sent: false, entryId: entry.id });
  } catch (error) {
    console.error('[WeComSend] Failed to process send request:', error);
    const message = error instanceof Error ? error.message : 'Failed to process send request';
    res.status(500).json({ error: 'send_failed', message });
  }
});

function findWecomUserForSession(workspaceId: string, sessionId: string): BotUser | null {
  const users = botService.listChannelUsersForWorkspace(workspaceId, 'wecom');
  for (const user of users) {
    const sessions = store.listUserSessionsByUser(user.id);
    if (sessions.some((s) => s.sessionId === sessionId)) {
      return user;
    }
  }
  return null;
}

function findWecomUserByPlaintext(workspaceId: string, plaintextUserId: string): BotUser | null {
  const users = botService.listChannelUsersForWorkspace(workspaceId, 'wecom');
  return users.find((u) => u.plaintextUserId === plaintextUserId) ?? null;
}

export default router;
