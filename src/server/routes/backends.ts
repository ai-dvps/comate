/**
 * Backend info routes (U5): expose the agent-backend registry to the client —
 * per-backend availability (binary + health check) and the resolved
 * capability declaration table, plus the persisted app-level default.
 */

import { Router } from 'express';
import {
  BACKEND_IDS,
  getBackendAvailability,
  getDefaultBackend,
  listBackendCapabilities,
  setDefaultBackend,
  type BackendId,
} from '../services/agent-backends.js';

const router = Router();

// GET /api/backends — availability + capability table per backend
router.get('/', async (_req, res) => {
  try {
    const backends = await Promise.all(
      BACKEND_IDS.map(async (id) => ({
        id,
        availability: await getBackendAvailability(id),
        capabilities: listBackendCapabilities(id),
      })),
    );
    res.json({ backends });
  } catch (error) {
    console.error('Failed to list backends:', error);
    res.status(500).json({ error: 'Failed to list backends' });
  }
});

// GET /api/backends/default
router.get('/default', async (_req, res) => {
  try {
    const backend = await getDefaultBackend();
    res.json({ backend: backend ?? null });
  } catch (error) {
    console.error('Failed to read default backend:', error);
    res.status(500).json({ error: 'Failed to read default backend' });
  }
});

// PUT /api/backends/default { backend }
router.put('/default', async (req, res) => {
  try {
    const backend = req.body?.backend as BackendId | undefined;
    if (backend !== 'claude' && backend !== 'opencode') {
      res.status(400).json({ error: "backend must be 'claude' or 'opencode'" });
      return;
    }
    await setDefaultBackend(backend);
    res.json({ backend });
  } catch (error) {
    console.error('Failed to set default backend:', error);
    res.status(500).json({ error: 'Failed to set default backend' });
  }
});

export default router;
