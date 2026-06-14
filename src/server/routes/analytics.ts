import { Router } from 'express';

import { analyticsService } from '../services/analytics-service.js';

const router = Router();

// GET /api/analytics/global
router.get('/global', async (_req, res) => {
  try {
    const summary = await analyticsService.getGlobalSummary();
    res.json({ summary });
  } catch (error) {
    console.error('Failed to compute global analytics:', error);
    res.status(500).json({ error: 'Failed to compute global analytics' });
  }
});

// GET /api/analytics/workspaces/:id
router.get('/workspaces/:id', async (req, res) => {
  try {
    const summary = await analyticsService.getWorkspaceSummary(req.params.id);
    if (!summary) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ summary });
  } catch (error) {
    console.error('Failed to compute workspace analytics:', error);
    res.status(500).json({ error: 'Failed to compute workspace analytics' });
  }
});

export default router;
