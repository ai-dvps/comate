import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';

const router = Router({ mergeParams: true });

// POST /api/workspaces/:id/wecom-queue — Enqueue a proactive message
router.post('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const { toUser, message } = req.body as { toUser?: string; message?: string };

    if (!toUser || typeof toUser !== 'string' || toUser.trim().length === 0) {
      res.status(400).json({ error: 'recipient_not_resolved', message: 'toUser is required' });
      return;
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message_required', message: 'message is required' });
      return;
    }

    const encryptedUserId = store.getEncryptedUserIdByPlaintext(toUser.trim());
    if (!encryptedUserId) {
      res.status(400).json({ error: 'recipient_not_resolved', message: 'WeCom user ID has not been decrypted yet' });
      return;
    }

    const sessionId = store.getWecomSession(workspaceId, encryptedUserId);
    if (!sessionId) {
      res.status(400).json({ error: 'recipient_no_session', message: 'Recipient has no session in this workspace' });
      return;
    }

    const entry = store.enqueueProactiveMessage(workspaceId, {
      senderSessionId: sessionId,
      recipientEncryptedUserId: encryptedUserId,
      recipientPlaintextUserId: toUser.trim(),
      messageContent: message.trim(),
    });

    res.status(202).json({ id: entry.id, status: entry.status });
  } catch (error) {
    console.error('Failed to enqueue proactive message:', error);
    const message = error instanceof Error ? error.message : 'Failed to enqueue message';
    res.status(500).json({ error: 'enqueue_failed', message });
  }
});

// GET /api/workspaces/:id/wecom-queue — List queue entries
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const statusFilter = req.query.status as string | undefined;
    const validStatuses = ['pending', 'delivering', 'delivered', 'failed'] as const;
    const filter = statusFilter && validStatuses.includes(statusFilter as typeof validStatuses[number])
      ? (statusFilter as typeof validStatuses[number])
      : undefined;

    const entries = store.listProactiveMessages(workspaceId, filter);
    res.json({ entries });
  } catch (error) {
    console.error('Failed to list queue entries:', error);
    res.status(500).json({ error: 'Failed to list queue entries' });
  }
});

// POST /api/workspaces/:id/wecom-queue/:entryId/retry — Retry a failed or delivering entry
router.post('/:entryId/retry', async (req, res) => {
  try {
    const entryId = req.params.entryId;
    const entry = store.getProactiveMessage(entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const updated = store.updateProactiveMessage(entryId, {
      status: 'pending',
      errorReason: null,
      retryCount: entry.retryCount + 1,
    });

    res.json({ entry: updated });
  } catch (error) {
    console.error('Failed to retry queue entry:', error);
    res.status(500).json({ error: 'Failed to retry queue entry' });
  }
});

// DELETE /api/workspaces/:id/wecom-queue/:entryId — Delete an entry
router.delete('/:entryId', async (req, res) => {
  try {
    const entryId = req.params.entryId;
    const deleted = store.deleteProactiveMessage(entryId);
    if (!deleted) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete queue entry:', error);
    res.status(500).json({ error: 'Failed to delete queue entry' });
  }
});

export default router;
