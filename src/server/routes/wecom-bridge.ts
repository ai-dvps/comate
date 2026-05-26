import { Router } from 'express';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { wecomUserResolver } from '../services/wecom-user-resolver.js';

const router = Router();

// POST /api/wecom/send
router.post('/send', async (req, res) => {
  try {
    const { botId, toUser, message, msgType } = req.body as {
      botId?: string;
      toUser?: string;
      message?: string;
      msgType?: 'text' | 'markdown';
    };

    if (!botId || !toUser || !message) {
      res.status(400).json({ error: 'botId, toUser, and message are required' });
      return;
    }

    const workspaceId = wecomBotService.getWorkspaceIdByBotId(botId);
    if (!workspaceId) {
      res.status(404).json({ error: 'Unknown bot ID' });
      return;
    }

    const status = wecomBotService.getStatus(workspaceId);
    if (status !== 'connected') {
      res.status(503).json({ error: `Bot is not connected (status: ${status})` });
      return;
    }

    await wecomBotService.sendProactiveMessage(botId, toUser, message);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to send WeCom message:', error);
    const message = error instanceof Error ? error.message : 'Failed to send message';
    res.status(502).json({ error: message });
  }
});

// POST /api/wecom/resolve-user
router.post('/resolve-user', async (req, res) => {
  try {
    const { workspaceId, encryptedUserId } = req.body as {
      workspaceId?: string;
      encryptedUserId?: string;
    };

    if (!workspaceId || !encryptedUserId) {
      res.status(400).json({ error: 'workspaceId and encryptedUserId are required' });
      return;
    }

    const plaintextUserId = await wecomUserResolver.resolveImmediate(workspaceId, encryptedUserId);
    res.json({ plaintextUserId });
  } catch (error) {
    console.error('Failed to resolve WeCom user ID:', error);
    const message = error instanceof Error ? error.message : 'Failed to resolve user ID';
    res.status(502).json({ error: message });
  }
});

export default router;
