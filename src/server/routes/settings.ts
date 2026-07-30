import { Router } from 'express';
import { diagWarn } from '../utils/diag-logger.js';
import {
  getBrowserAllowInsecureCerts,
  setBrowserAllowInsecureCerts,
} from '../services/browser-app-settings.js';

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

  return router;
}

export default createSettingsRouter();
