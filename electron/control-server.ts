/**
 * U7 (KTD-11): shell-side control channel — a per-boot-token-gated HTTP
 * server on 127.0.0.1 carrying the browser-view lifecycle between the sidecar
 * and the Electron main process. Mirrors the sidecar ready-line handshake
 * pattern: the token is minted per boot and handed to the sidecar via spawn
 * env only (never logged, never served).
 *
 * Endpoint surface (all require `Authorization: Bearer <token>`):
 *  - GET  /health                        liveness + quitting flag
 *  - POST /views        {sessionId}      create the session's WebContentsView
 *                                        (persist:comate-browser-<id> partition,
 *                                        KTD-10/KTD-16 webPreferences), loaded
 *                                        with the about:blank#<marker> the
 *                                        sidecar uses for CDP target discovery
 *  - DELETE /views/:sessionId            destroy the view
 *  - POST /partitions/:sessionId/wipe    wipe the partition (session/workspace
 *                                        deletion — the wipeProfile semantic)
 *  - POST /views/:sessionId/bounds       panel rect report (U8: applies
 *                                        setBounds + window attach)
 *  - GET  /views/:sessionId/state        U8 attestation snapshot (attached /
 *                                        visible / bounds / gating / popups)
 *  - POST /partitions/reconcile  {keep}  U8 orphan-partition sweep: partition
 *                                        dirs absent from the sidecar's
 *                                        session registry are deleted (KTD-11)
 *  - GET  /events                        SSE stream: view-crashed /
 *                                        view-destroyed (U7), view-activity
 *                                        and view-navigated (U8)
 *
 * Quitting state: while the app is quitting, POST /views is rejected (409) so
 * no view outlives the shutdown path.
 *
 * This module stays electron-free (like sidecar.ts): the Electron view
 * manager (electron/browser-view-manager.ts) is injected via the
 * ControlViewManager interface so node:test can drive fakes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserViewWebPreferencesReport {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  preload: string | null;
}

export interface CreateViewResult {
  partition: string;
  targetMarker: string;
  /** getLastWebPreferences() of the live view — the KTD-16 security attestation. */
  webPreferences: BrowserViewWebPreferencesReport;
}

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** U8 attestation snapshot of a live view (GET /views/:id/state). */
export interface ControlViewState {
  attached: boolean;
  visible: boolean;
  bounds: ViewRect | null;
  inputMode: 'user' | 'agent';
  /** True while the transparent shield swallows pointer input (agent mode). */
  pointerGated: boolean;
  popupCount: number;
  lastUrl: string | null;
}

export interface ControlViewManager {
  createView(input: { sessionId: string; marker: string }): Promise<CreateViewResult>;
  /** Returns whether a live view was destroyed. */
  destroyView(sessionId: string): Promise<boolean>;
  wipePartition(sessionId: string): Promise<void>;
  /** U8: stores the panel rect and applies bounds/attach to the live view. */
  setViewBounds(sessionId: string, rect: ViewRect | null): Promise<void>;
  /** U8 attestation snapshot; null when the session has no live view. */
  getViewState(sessionId: string): unknown;
  /** U8 orphan-partition reconciliation (KTD-11). */
  reconcilePartitions(keep: string[]): Promise<{ removed: string[]; errors: string[] }>;
}

export type ControlEvent =
  | { type: 'view-crashed'; sessionId: string; reason: string; at: number }
  | { type: 'view-destroyed'; sessionId: string; at: number }
  | { type: 'view-activity'; sessionId: string; at: number }
  | { type: 'view-navigated'; sessionId: string; url: string; at: number };

export interface ControlServerLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn?(message: string): void;
  error(message: string): void;
}

export interface ControlServerDeps {
  /** Per-boot credential; compared via SHA-256 + timingSafeEqual. */
  token: string;
  views: ControlViewManager;
  isQuitting: () => boolean;
  logger?: ControlServerLogger;
  /** Bind host — locked to loopback (KTD-6 lockdown). */
  host?: string;
  /** Port override (0 = OS-assigned; the shell passes the real port via env). */
  port?: number;
}

export interface ControlServerHandle {
  port: number;
  /** Push an event onto every subscribed SSE stream (view manager → sidecar). */
  emit(event: ControlEvent): void;
  close(): Promise<void>;
}

/** sessionId safety: the id becomes a partition name — never path material. */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createControlServer(deps: ControlServerDeps): Promise<ControlServerHandle> {
  const host = deps.host ?? '127.0.0.1';
  const sseClients = new Set<ServerResponse>();

  const emit = (event: ControlEvent): void => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of [...sseClients]) {
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(deps.token, presented)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, quitting: deps.isQuitting() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': comate control channel\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/views') {
        if (deps.isQuitting()) {
          sendJson(res, 409, { ok: false, error: 'quitting', message: 'The app is quitting; no new browser views.' });
          return;
        }
        let body: { sessionId?: unknown; marker?: unknown };
        try {
          body = JSON.parse(await readBody(req)) as { sessionId?: unknown; marker?: unknown };
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)) {
          sendJson(res, 400, { ok: false, error: 'invalid_session_id' });
          return;
        }
        if (typeof body.marker !== 'string' || body.marker.length === 0 || body.marker.length > 256) {
          sendJson(res, 400, { ok: false, error: 'invalid_marker' });
          return;
        }
        try {
          const created = await deps.views.createView({ sessionId: body.sessionId, marker: body.marker });
          sendJson(res, 201, { ok: true, sessionId: body.sessionId, ...created });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('already exists')) {
            sendJson(res, 409, { ok: false, error: 'view_exists', message });
          } else {
            deps.logger?.error(`[control] view creation failed for ${body.sessionId}: ${message}`);
            sendJson(res, 502, { ok: false, error: 'view_creation_failed', message });
          }
        }
        return;
      }

      const viewMatch = /^\/views\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && viewMatch) {
        const destroyed = await deps.views.destroyView(viewMatch[1]!);
        sendJson(res, 200, { ok: true, destroyed });
        return;
      }

      if (req.method === 'GET' && viewMatch) {
        const state = deps.views.getViewState(viewMatch[1]!);
        if (state === null || state === undefined) {
          sendJson(res, 404, { ok: false, error: 'no_view' });
          return;
        }
        sendJson(res, 200, { ok: true, state });
        return;
      }

      const boundsMatch = /^\/views\/([a-zA-Z0-9_-]+)\/bounds$/.exec(url.pathname);
      if (req.method === 'POST' && boundsMatch) {
        let rect: ViewRect;
        try {
          rect = JSON.parse(await readBody(req)) as ViewRect;
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (
          ![rect.x, rect.y, rect.width, rect.height].every((v) => typeof v === 'number' && Number.isFinite(v))
        ) {
          sendJson(res, 400, { ok: false, error: 'invalid_rect' });
          return;
        }
        await deps.views.setViewBounds(boundsMatch[1]!, rect);
        sendJson(res, 200, { ok: true });
        return;
      }

      const wipeMatch = /^\/partitions\/([a-zA-Z0-9_-]+)\/wipe$/.exec(url.pathname);
      if (req.method === 'POST' && wipeMatch) {
        await deps.views.wipePartition(wipeMatch[1]!);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/partitions/reconcile') {
        let body: { keep?: unknown };
        try {
          body = JSON.parse(await readBody(req, 256 * 1024)) as { keep?: unknown };
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (
          !Array.isArray(body.keep) ||
          body.keep.length > 10_000 ||
          !body.keep.every((id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id))
        ) {
          sendJson(res, 400, { ok: false, error: 'invalid_keep_list' });
          return;
        }
        const result = await deps.views.reconcilePartitions(body.keep);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    })().catch((err) => {
      deps.logger?.error(`[control] unhandled request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('control server did not bind a port'));
        return;
      }
      resolve({
        port: address.port,
        emit,
        close: () =>
          new Promise<void>((done) => {
            for (const res of [...sseClients]) {
              try {
                res.end();
              } catch {
                // already gone
              }
            }
            server.close(() => done());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The Electron view manager implementation moved to
// electron/browser-view-manager.ts in U8 (window attach, bounds, occlusion,
// input gating, managed popups, activity/navigated events, reconciliation).
// ---------------------------------------------------------------------------
