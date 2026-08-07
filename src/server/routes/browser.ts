import { Router } from 'express';
import { browserService } from '../services/browser-service.js';

/**
 * Browser session routes (native stack, U8/U9). The viewer-url endpoint left
 * with the iframe viewer in U9 — the panel is backed by the shell's
 * WebContentsView (rect reporting over the desktop bridge) and shows its
 * degraded "needs the desktop app" state elsewhere.
 */

export interface BrowserRouteDeps {
  /**
   * U8 (native stack): session_lost manual retry — rebuild the view over the
   * control channel and navigate back to the session's last URL.
   */
  retrySession: (sessionId: string) => Promise<{ rebuilding: boolean }>;
}

export function createBrowserRouter(overrides?: Partial<BrowserRouteDeps>): Router {
  const deps: BrowserRouteDeps = {
    retrySession: (sessionId) => browserService.retrySession(sessionId),
    ...overrides,
  };

  const router = Router();

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
