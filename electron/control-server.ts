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
 *  - POST /views/:sessionId/bounds       panel rect report (stored only in U7;
 *                                        U8 wires it to setBounds)
 *  - GET  /events                        SSE stream: view-crashed /
 *                                        view-destroyed (U7) and view-activity
 *                                        (surface designed now, emitted by U8)
 *
 * Quitting state: while the app is quitting, POST /views is rejected (409) so
 * no view outlives the shutdown path.
 *
 * This module stays electron-free (like sidecar.ts): the Electron view
 * manager is created via injected factories so node:test can drive fakes.
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

export interface ControlViewManager {
  createView(input: { sessionId: string; marker: string }): Promise<CreateViewResult>;
  /** Returns whether a live view was destroyed. */
  destroyView(sessionId: string): Promise<boolean>;
  wipePartition(sessionId: string): Promise<void>;
  /** U8 surface: store the panel rect for the view (no window attach in U7). */
  setViewBounds(sessionId: string, rect: ViewRect): Promise<void>;
}

export type ControlEvent =
  | { type: 'view-crashed'; sessionId: string; reason: string; at: number }
  | { type: 'view-destroyed'; sessionId: string; at: number }
  | { type: 'view-activity'; sessionId: string; at: number };

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
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

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
// Electron view manager (real implementation; factories injected so this file
// stays importable under plain node:test — the tray.ts pattern)
// ---------------------------------------------------------------------------

interface ElectronSessionLike {
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null,
  ): void;
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | null,
  ): void;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

interface ElectronWebContentsLike {
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
  destroy(): void;
  isDestroyed(): boolean;
  setWindowOpenHandler(
    handler: (details: { url: string }) => {
      action: 'allow' | 'deny';
      overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> };
    },
  ): void;
  getLastWebPreferences(): Record<string, unknown>;
}

interface ElectronViewLike {
  webContents: ElectronWebContentsLike;
  setBounds(rect: ViewRect): void;
}

export interface ElectronViewManagerDeps {
  /** `(opts) => new WebContentsView(opts)` — injected to keep electron out of unit tests. */
  createViewImpl: (options: { webPreferences: Record<string, unknown> }) => ElectronViewLike;
  /** `session.fromPartition` equivalent. */
  sessionFromPartition: (partition: string) => ElectronSessionLike;
  /** Sink for view lifecycle events (wired to the control server's SSE emit). */
  onEvent: (event: ControlEvent) => void;
  logger?: ControlServerLogger;
}

export type ElectronViewManager = ControlViewManager & {
  /** Quit path: destroy every live view (best-effort). */
  destroyAll(): Promise<void>;
  /** Test/attestation hook: live view count. */
  size(): number;
};

/** Locked webPreferences for browser views AND their same-partition popups (KTD-16). */
const VIEW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // No preload — ever. A preload would bridge Node/Electron into untrusted pages.
} as const;

/**
 * Per-session browser views (KTD-10): one WebContentsView per chat session on
 * `persist:comate-browser-<sessionId>`. Views are created UNATTACHED with
 * zero bounds in U7 — U8 wires them into the panel. Each view loads
 * `about:blank#<marker>` so the sidecar can find its CDP page target on the
 * debug port before the first real navigation (marker verified to survive in
 * /json/list on CfT 151 / Electron 43).
 */
export function createElectronViewManager(deps: ElectronViewManagerDeps): ElectronViewManager {
  const views = new Map<string, ElectronViewLike>();
  const bounds = new Map<string, ViewRect>();
  const partitions = new Map<string, ElectronSessionLike>();

  const partitionName = (sessionId: string): string => `persist:comate-browser-${sessionId}`;
  const sessionFor = (sessionId: string): ElectronSessionLike => {
    let ses = partitions.get(sessionId);
    if (!ses) {
      ses = deps.sessionFromPartition(partitionName(sessionId));
      // Deny-by-default permission policy for untrusted web content (plan
      // System-Wide Impact auth boundary).
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      partitions.set(sessionId, ses);
    }
    return ses;
  };

  return {
    size: () => views.size,

    async createView({ sessionId, marker }) {
      if (views.has(sessionId)) {
        throw new Error(`browser view already exists for session ${sessionId}`);
      }
      const partition = partitionName(sessionId);
      // Install the deny-by-default permission policy on the partition before
      // any document loads in it.
      sessionFor(sessionId);
      const view = deps.createViewImpl({
        webPreferences: { ...VIEW_WEB_PREFERENCES, partition },
      });
      const { webContents } = view;
      // Unattached but sized: a zero-area view cannot produce screenshots
      // (no compositor surface) and several CDP layout paths misbehave; U8
      // re-bounds the view to the panel rect when it wires attach.
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      webContents.setWindowOpenHandler(({ url }) => {
        // KTD-14: browser views allow same-partition popups (OAuth login
        // flows); the popup gets the same locked webPreferences (KTD-16).
        // Non-web schemes are denied outright.
        if (!/^https?:\/\//.test(url)) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: { ...VIEW_WEB_PREFERENCES, partition },
          },
        };
      });
      webContents.on('render-process-gone', (_event: unknown, details: { reason?: string }) => {
        deps.onEvent({
          type: 'view-crashed',
          sessionId,
          reason: details?.reason ?? 'unknown',
          at: Date.now(),
        });
      });
      webContents.on('destroyed', () => {
        views.delete(sessionId);
        deps.onEvent({ type: 'view-destroyed', sessionId, at: Date.now() });
      });
      views.set(sessionId, view);
      try {
        await webContents.loadURL(`about:blank#${marker}`);
      } catch (err) {
        views.delete(sessionId);
        if (!webContents.isDestroyed()) webContents.destroy();
        throw err;
      }
      const lastPrefs = webContents.getLastWebPreferences();
      return {
        partition,
        targetMarker: marker,
        webPreferences: {
          sandbox: lastPrefs['sandbox'] === true,
          contextIsolation: lastPrefs['contextIsolation'] === true,
          nodeIntegration: lastPrefs['nodeIntegration'] === true,
          preload: typeof lastPrefs['preload'] === 'string' ? (lastPrefs['preload'] as string) : null,
        },
      };
    },

    async destroyView(sessionId) {
      const view = views.get(sessionId);
      if (!view) return false;
      views.delete(sessionId);
      bounds.delete(sessionId);
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy();
      }
      return true;
    },

    async wipePartition(sessionId) {
      // Login state must not outlive the session: destroy any live view, then
      // clear the partition's storage + cache (the wipeProfile semantic).
      const view = views.get(sessionId);
      if (view) {
        views.delete(sessionId);
        if (!view.webContents.isDestroyed()) view.webContents.destroy();
      }
      const ses = partitions.get(sessionId) ?? deps.sessionFromPartition(partitionName(sessionId));
      await ses.clearStorageData();
      await ses.clearCache();
      partitions.delete(sessionId);
    },

    async setViewBounds(sessionId, rect) {
      bounds.set(sessionId, rect);
      // U8 wires this to the panel: views stay unattached in U7.
    },

    async destroyAll() {
      for (const [sessionId, view] of [...views]) {
        views.delete(sessionId);
        try {
          if (!view.webContents.isDestroyed()) view.webContents.destroy();
        } catch (err) {
          deps.logger?.warn?.(
            `[control] failed to destroy view ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
