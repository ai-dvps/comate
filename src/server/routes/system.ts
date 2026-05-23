import { Router } from 'express';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { chatService } from '../services/chat-service.js';

const router = Router();

// GET /api/system/tray-status
// Aggregated status read by the Tauri tray poller. Keep this endpoint cheap —
// it fires every 5s while the app is running, hidden or visible.
router.get('/tray-status', async (_req, res) => {
  try {
    const wecom = await wecomBotService.getAggregateStatus();
    res.json({
      wecomBot: wecom.state,
      activeSessions: chatService.getActiveSessionCount(),
    });
  } catch (error) {
    console.error('Failed to compute tray status:', error);
    res.status(500).json({ error: 'Failed to compute tray status' });
  }
});

export default router;
