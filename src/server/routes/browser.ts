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
  /**
   * U8 (native stack): session_lost manual retry — rebuild the view over the
   * control channel and navigate back to the session's last URL.
   */
  retrySession: (sessionId: string) => Promise<{ rebuilding: boolean }>;
}

export function createBrowserRouter(overrides?: Partial<BrowserRouteDeps>): Router {
  const deps: BrowserRouteDeps = {
    hasLiveSession: (sessionId) => browserService.getSession(sessionId) !== undefined,
    getViewerUrl: (sessionId) => browserViewerProxy.getViewerUrl(sessionId),
    retrySession: (sessionId) => browserService.retrySession(sessionId),
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

  // U8: manual retry for a lost native browser session. Idempotent — a live
  // or already-rebuilding session answers { rebuilding: false }.
  router.post('/:sessionId/retry', (req, res) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) {
      res.status(400).json({ ok: false, error: 'session id required' });
      return;
    }
    deps
      .retrySession(sessionId)
      .then((result) => {
        res.json({ ok: true, rebuilding: result.rebuilding });
      })
      .catch((err: unknown) => {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  return router;
}

export default createBrowserRouter();
