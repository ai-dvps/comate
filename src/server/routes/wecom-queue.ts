import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';

const router = Router({ mergeParams: true });

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
