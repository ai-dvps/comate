import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { botService } from '../services/bot-service.js';
import type { BotUser } from '../models/bot-user.js';

const router = Router({ mergeParams: true });

// POST /api/workspaces/:workspaceId/wecom/send-file
router.post('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { workspaceId: string }).workspaceId;
    const { sessionId, toUser, filePath } = req.body as {
      sessionId?: string;
      toUser?: string;
      filePath?: string;
    };

    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!toUser || typeof toUser !== 'string' || toUser.trim().length === 0) {
      res.status(400).json({ error: 'toUser is required' });
      return;
    }
    if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
      res.status(400).json({ error: 'filePath is required' });
      return;
    }

    const callerUser = findWecomUserForSession(workspaceId, sessionId);
    if (!callerUser) {
      res.status(400).json({
        error: 'unknown_session',
        message: 'Session is not associated with a WeCom user in this workspace.',
      });
      return;
    }

    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    const callerCanonicalUserId = callerUser.plaintextUserId ?? callerUser.channelUserId;
    const isAdmin = workspace.settings.wecomBotIsolation?.adminUserIds?.includes(callerCanonicalUserId) ?? false;

    await wecomBotService.sendFile(workspaceId, toUser.trim(), filePath.trim(), isAdmin);

    res.status(200).json({ sent: true });
  } catch (error) {
    console.error('[WeComSendFile] Failed to process send-file request:', error);
    const message = error instanceof Error ? error.message : 'Failed to process send-file request';

    if (
      message.includes('File access denied') ||
      message.includes('Workspace') ||
      message.includes('WeCom user ID has not been decrypted') ||
      message.includes('not a file') ||
      message.includes('outside-workspace') ||
      message.includes('other-user-dir')
    ) {
      res.status(400).json({ error: 'send_file_failed', message });
      return;
    }

    if (message.includes('not connected')) {
      res.status(503).json({
        error: 'bot_not_connected',
        message: 'WeCom bot is not connected for this workspace. Please reconnect the bot and retry.',
      });
      return;
    }

    res.status(500).json({ error: 'send_file_failed', message });
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

export default router;
