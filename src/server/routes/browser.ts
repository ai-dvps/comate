import { Router } from 'express';
import { browserViewerProxy } from './browser-proxy.js';
import { browserService } from '../services/browser-service.js';

/**
 * GET /api/browser/:sessionId/viewer-url — the one server-side door through
 * which the chat panel (U6) obtains the viewer iframe URL (KTD-7). The URL —
 * including the per-session viewer token — is ONLY ever constructed here and
 * handed server→client; agents and users never supply it, and it is never
 * logged.
 *
 * `{ url: null }` when the session has no live browser (never spawned, still
 * starting, or session_lost after a crash) so the panel renders its
 * empty/starting/lost states instead of an iframe that would 503.
 *
 * U9 hardening rides the app-wide middleware stack in server-main
 * (hostHeaderGuard + the CORS app-origin matrix); a GET changes no state, so
 * the route itself needs no extra guard.
 */

export interface BrowserRouteDeps {
  /** Live-session probe (undefined while starting / session_lost / unknown). */
  hasLiveSession: (sessionId: string) => boolean;
  /** Server-constructed viewer URL; undefined when the proxy is down. */
  getViewerUrl: (sessionId: string) => string | undefined;
}

export function createBrowserRouter(overrides?: Partial<BrowserRouteDeps>): Router {
  const deps: BrowserRouteDeps = {
    hasLiveSession: (sessionId) => browserService.getSession(sessionId) !== undefined,
    getViewerUrl: (sessionId) => browserViewerProxy.getViewerUrl(sessionId),
    ...overrides,
  };

  const router = Router();

  router.get('/:sessionId/viewer-url', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!sessionId || !deps.hasLiveSession(sessionId)) {
      res.json({ url: null });
      return;
    }
    res.json({ url: deps.getViewerUrl(sessionId) ?? null });
  });

  return router;
}

export default createBrowserRouter();
