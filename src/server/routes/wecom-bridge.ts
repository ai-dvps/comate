import { Router } from 'express';
import { wecomUserResolver } from '../services/wecom-user-resolver.js';

const router = Router();

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
