import { Router } from 'express';
import { diagWarn } from '../utils/diag-logger.js';
import {
  getBrowserAllowInsecureCerts,
  setBrowserAllowInsecureCerts,
} from '../services/browser-app-settings.js';
import { getNightWindow, setNightWindow } from '../services/todo-app-settings.js';

/**
 * App-global settings surface. Currently exposes the embedded-browser
 * "allow insecure certificates" toggle — the only app-level preference the
 * server must read (at Chrome spawn), so it is persisted server-side here
 * rather than in the client-local (localStorage) app prefs.
 *
 *   GET /api/settings/browser        → { allowInsecureCerts: boolean }   (default true)
 *   PUT /api/settings/browser  body  → { allowInsecureCerts: boolean }   → echoes stored value
 *
 * The factory accepts overrides for the get/set pair so tests can exercise the
 * handlers without touching the app-settings file (mirrors health-browser).
 */

export interface SettingsRouteDeps {
  getAllowInsecureCerts: () => Promise<boolean>;
  setAllowInsecureCerts: (value: boolean) => Promise<void>;
}

export function createSettingsRouter(overrides?: Partial<SettingsRouteDeps>): Router {
  const deps: SettingsRouteDeps = {
    getAllowInsecureCerts: getBrowserAllowInsecureCerts,
    setAllowInsecureCerts: setBrowserAllowInsecureCerts,
    ...overrides,
  };

  const router = Router();

  router.get('/browser', async (_req, res) => {
    try {
      const allowInsecureCerts = await deps.getAllowInsecureCerts();
      res.json({ allowInsecureCerts });
    } catch (err) {
      diagWarn('[settings] failed to read browser settings:', err);
      res.status(500).json({ error: 'Failed to read browser settings' });
    }
  });

  router.put('/browser', async (req, res) => {
    const value = req.body?.allowInsecureCerts;
    if (typeof value !== 'boolean') {
      res.status(400).json({ error: 'allowInsecureCerts must be a boolean' });
      return;
    }
    try {
      await deps.setAllowInsecureCerts(value);
      res.json({ allowInsecureCerts: value });
    } catch (err) {
      diagWarn('[settings] failed to save browser settings:', err);
      res.status(500).json({ error: 'Failed to save browser settings' });
    }
  });

  router.get('/todo-night-window', async (_req, res) => {
    try {
      res.json({ nightWindow: await getNightWindow() });
    } catch (err) {
      diagWarn('[settings] failed to read todo night window:', err);
      res.status(500).json({ error: 'Failed to read todo night window' });
    }
  });

  router.put('/todo-night-window', async (req, res) => {
    const value = req.body?.nightWindow;
    const validTime = (time: unknown): time is string => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
    if (!value || typeof value.enabled !== 'boolean' || !validTime(value.start) || !validTime(value.end)) {
      res.status(400).json({ error: 'nightWindow requires enabled, start, and end (HH:mm)' });
      return;
    }
    try {
      await setNightWindow(value);
      res.json({ nightWindow: value });
    } catch (err) {
      diagWarn('[settings] failed to save todo night window:', err);
      res.status(500).json({ error: 'Failed to save todo night window' });
    }
  });

  return router;
}

export default createSettingsRouter();
