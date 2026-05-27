import { Router } from 'express';
import path from 'path';
import { wecomBotService } from '../services/wecom-bot-service.js';
import { chatService } from '../services/chat-service.js';
import { getResolvedShellPath } from '../utils/resolve-shell-path.js';
import { loadCustomPaths, saveCustomPaths } from '../utils/path-config.js';

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

// GET /api/system/path
// Returns the resolved PATH, custom paths, and enrichment sources.
router.get('/path', (_req, res) => {
  try {
    const resolved = getResolvedShellPath();
    const customPaths = loadCustomPaths();
    res.json({
      resolvedPath: resolved.path,
      customPaths,
      sources: {
        shell: resolved.shellDirs,
        fallback: resolved.fallbackDirs,
      },
    });
  } catch (error) {
    console.error('Failed to load PATH state:', error);
    res.status(500).json({ error: 'Failed to load PATH state' });
  }
});

// POST /api/system/path
// Accepts custom paths, validates them, persists, and returns updated state.
router.post('/path', (req, res) => {
  try {
    const { customPaths } = req.body;
    if (!Array.isArray(customPaths)) {
      res.status(400).json({ error: 'customPaths must be an array' });
      return;
    }
    const invalid = customPaths.filter(
      (p) => typeof p !== 'string' || p.trim().length === 0 || !path.isAbsolute(p.trim()),
    );
    if (invalid.length > 0) {
      res.status(400).json({ error: 'Each path must be a non-empty absolute path', invalid });
      return;
    }
    const normalized = customPaths.map((p: string) => p.trim());
    saveCustomPaths(normalized);
    const resolved = getResolvedShellPath();
    res.json({
      resolvedPath: resolved.path,
      customPaths: normalized,
      sources: {
        shell: resolved.shellDirs,
        fallback: resolved.fallbackDirs,
      },
    });
  } catch (error) {
    console.error('Failed to save custom paths:', error);
    res.status(500).json({ error: 'Failed to save custom paths' });
  }
});

export default router;
