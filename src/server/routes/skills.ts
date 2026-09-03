import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { commandsService } from '../services/commands-service.js';
import { discoverInstalledSkills } from '../services/skill-inventory.js';

const router = Router();

// Inventory only. Installation, removal and updates belong to the agent's CLI.
router.get('/installed', async (req, res) => {
  const id = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  try {
    const workspace = id ? await store.get(id) : undefined;
    if (id && !workspace) { res.status(404).json({ error: 'Workspace not found' }); return; }
    const version = workspace ? commandsService.watchSkills(workspace.folderPath) : 0;
    res.json({ skills: await discoverInstalledSkills(workspace?.folderPath), version });
  } catch {
    res.status(500).json({ error: 'Failed to list installed skills' });
  }
});

export default router;
