import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '../models/workspace.js';

const router = Router();

// GET /api/workspaces
router.get('/', async (_req, res) => {
  try {
    const workspaces = await store.list();
    res.json({ workspaces });
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// POST /api/workspaces
router.post('/', async (req, res) => {
  try {
    const input = req.body as CreateWorkspaceInput;

    if (!input.name || !input.folderPath) {
      res.status(400).json({ error: 'name and folderPath are required' });
      return;
    }

    const workspace = await store.create(input);
    res.status(201).json({ workspace });
  } catch (error) {
    console.error('Failed to create workspace:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// GET /api/workspaces/:id
router.get('/:id', async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ workspace });
  } catch (error) {
    console.error('Failed to get workspace:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// PUT /api/workspaces/:id
router.put('/:id', async (req, res) => {
  try {
    const input = req.body as UpdateWorkspaceInput;
    const workspace = await store.update(req.params.id, input);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ workspace });
  } catch (error) {
    console.error('Failed to update workspace:', error);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// DELETE /api/workspaces/:id
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await store.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

export default router;
