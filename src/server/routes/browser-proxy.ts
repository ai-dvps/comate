import http, { type IncomingMessage, type Server, type ServerResponse } from 'http';
import net, { type Socket } from 'net';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { browserService } from '../services/browser-service.js';
import { isWhitelistedHostHeader } from '../services/security/request-origin-guard.js';
import { VIEWER_TOKEN_PATTERN } from '../services/browser-viewer-token.js';

/**
 * Viewer proxy (plan U7, KTD-7) — the ONLY door to a session's Steel viewer.
 *
 * Runs on its own loopback port, deliberately separate from the sidecar API
 * listener: a different port is a different origin, so the Steel viewer — a
 * third-party UI rendering hostile-page-derived pixels — shares no origin
 * (cookies, storage, CORS) with the sidecar API it could otherwise attack via
 * XSS. The per-session viewer token (minted by browser-service, delivered
 * once via the iframe URL) is the primary defense; it rides in the PATH so
 * both the plain HTTP and the WebSocket-upgrade paths authenticate the same
 * way:
 *
 *   iframe src  = http://127.0.0.1:<proxyPort>/s/<token>/v1/sessions/debug?…
 *   cast wsUrl  = ws://127.0.0.1:<proxyPort>/s/<token>/v1/sessions/cast?…
 *                 (baked into the viewer HTML by Steel from the DOMAIN env
 *                  browser-service injects at spawn — see viewerDomain dep)
 *
 * The forward list is exactly what the pinned viewer opens (U7 spike
 * enumeration against the vendored Steel build):
 *   GET  /v1/sessions/debug   viewer HTML (single file, inline assets)
 *   WS   /v1/sessions/cast    tab-discovery (?tabInfo=true) + per-tab stream
 *                             (?pageId=…) carrying JPEG frames in and
 *                             mouse/keyboard/navigation events out
 * Least privilege: a token grants view+input ONLY — the rest of the Steel API
 * (scrape/screenshot/context export/release) is NOT forwarded.
 *
 * Failure contract (no hangs, no oracle):
 *  - unknown/wrong/missing token, bad Host, non-viewer path → generic 403/404
 *    with `X-Frame-Options: DENY` (same shape for every auth failure — the
 *    proxy never reveals whether a token guess was close)
 *  - valid token but Steel not live (starting/session_lost/dead) → explicit
 *    503, fast — the iframe surfaces a crash state instead of spinning
 *  - cold-start race: the first debug request per spawned process waits for
 *    the browser to publish a page (Steel's /v1/health 200 precedes CDP
 *    wsEndpoint readiness, and the viewer's tab-discovery cast never retries)
 */

const VIEWER_PATH_PATTERN = new RegExp(`^/s/(${VIEWER_TOKEN_PATTERN})(/|$)`);
const VIEWER_HTTP_PATH = 'v1/sessions/debug';
const VIEWER_WS_PATH = 'v1/sessions/cast';

const DENY_HEADERS = {
  'content-type': 'application/json',
  'x-frame-options': 'DENY',
  // Never any ACAO header: a cross-origin page cannot read even the error.
} as const;

/**
 * 503 crash-state page: intentionally frameable. The viewer loads inside an
 * iframe, and returning X-Frame-Options: DENY on this error would make the
 * pane render as a black rectangle instead of surfacing the crash state.
 * No token oracle here — the 503 is only reached after the token validated.
 */
const UNAVAILABLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser unavailable</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
    body {
      display: flex; align-items: center; justify-content: center;
      background: #171717; color: #ffffff;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .message { text-align: center; padding: 24px; }
    .message h1 { font-size: 16px; font-weight: 500; margin: 0 0 8px; }
    .message p { font-size: 13px; color: #8a8a8a; margin: 0; }
  </style>
</head>
<body>
  <div class="message">
    <h1>Browser unavailable</h1>
    <p>The embedded browser session is not reachable. It may be starting, stopped, or has crashed.</p>
  </div>
</body>
</html>`;

const DEFAULT_WARM_TIMEOUT_MS = 15_000;
const DEFAULT_WARM_INTERVAL_MS = 300;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
/** FIFO bound for the warmed key set (keys outlive their sessions otherwise). */
const MAX_WARMED_KEYS = 512;

/** Narrow slice of browser-service the proxy routes through (test seam). */
export interface ViewerSessionLookup {
  findSessionByViewerToken(
    token: string,
  ): { sessionId: string; info: { port: number; startedAt: number } | undefined } | undefined;
  getViewerToken(sessionId: string): string | undefined;
}

export interface BrowserViewerProxyDeps {
  lookup: ViewerSessionLookup;
  /** Post-start wiring: hands the DOMAIN provider to browser-service. */
  registerDomainProvider?: (provider: (token: string) => string | undefined) => void;
  host?: string;
  warmTimeoutMs?: number;
  warmIntervalMs?: number;
  upstreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, DENY_HEADERS);
  res.end(JSON.stringify({ error: message }));
}

/** Frameable 503 crash-state page for the viewer iframe (see UNAVAILABLE_HTML). */
function unavailable(res: ServerResponse): void {
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(UNAVAILABLE_HTML);
}

/** Writes an HTTP error response onto a raw upgrade socket, then destroys it. */
function denyUpgrade(socket: Socket, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
      'content-type: application/json\r\n' +
      'x-frame-options: DENY\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}

interface ViewerTarget {
  sessionId: string;
  /** Path remainder after the token prefix, e.g. 'v1/sessions/cast'. */
  rest: string;
  search: string;
  port: number | undefined;
  startedAt: number;
}

export class BrowserViewerProxy {
  private readonly deps: BrowserViewerProxyDeps;
  private server: Server | null = null;
  private boundPort = 0;
  /** Warm keys: `${sessionId}:${startedAt}` — a respawn must re-warm. */
  private readonly warmed = new Set<string>();
  private readonly warming = new Map<string, Promise<boolean>>();
  /**
   * All live sockets (plain + upgraded). http.Server does not track upgraded
   * sockets for close()/closeAllConnections(), so stop() destroys them itself.
   */
  private readonly sockets = new Set<Socket>();

  constructor(deps: BrowserViewerProxyDeps) {
    this.deps = deps;
  }

  /** The proxy's loopback port; 0 until start() resolves. */
  get port(): number {
    return this.boundPort;
  }

  /** Base `host:port/s/<token>` — the DOMAIN value for Steel spawns. */
  viewerDomainFor = (token: string): string | undefined => {
    if (!this.boundPort) return undefined;
    return `127.0.0.1:${this.boundPort}/s/${token}`;
  };

  /**
   * The one-shot iframe URL U6 embeds (KTD-7: server-constructed, never from
   * agent/user input). Undefined until the proxy listens, or when the session
   * (and thus its token) is unknown.
   */
  getViewerUrl(sessionId: string): string | undefined {
    if (!this.boundPort) return undefined;
    const token = this.deps.lookup.getViewerToken(sessionId);
    if (!token) return undefined;
    return (
      `http://127.0.0.1:${this.boundPort}/s/${token}/v1/sessions/debug` +
      '?interactive=true&theme=dark&showControls=true'
    );
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        diagWarn('[browser-proxy] http handler error:', err);
        if (!res.headersSent) deny(res, 500, 'Internal error');
        res.end();
      });
    });
    const track = (socket: Socket): void => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    };
    server.on('connection', track);
    server.on('upgrade', (req, upgradeSocket, head) => {
      // @types/node types the upgrade socket as Duplex; an http upgrade
      // socket is always a net.Socket (the proxy pipes/destroys it as one).
      const socket = upgradeSocket as Socket;
      track(socket);
      try {
        this.handleUpgrade(req, socket, head);
      } catch (err) {
        diagWarn('[browser-proxy] upgrade handler error:', err);
        socket.destroy();
      }
    });
    const host = this.deps.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        this.boundPort = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        this.deps.registerDomainProvider?.(this.viewerDomainFor);
        diagLog(`[browser-proxy] viewer proxy listening on http://${host}:${this.boundPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    this.deps.registerDomainProvider?.(() => undefined);
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // ── shared routing ─────────────────────────────────────────────────────────

  /** Resolves a request URL to its routing target, or null when unauthorized. */
  private resolveTarget(url: string): ViewerTarget | null {
    const match = VIEWER_PATH_PATTERN.exec(url);
    if (!match) return null;
    const token = match[1];
    const restWithQuery = url.slice(match[0].length);
    const qIndex = restWithQuery.indexOf('?');
    const rest = qIndex === -1 ? restWithQuery : restWithQuery.slice(0, qIndex);
    const search = qIndex === -1 ? '' : restWithQuery.slice(qIndex);
    const found = this.deps.lookup.findSessionByViewerToken(token);
    if (!found) return null;
    return {
      sessionId: found.sessionId,
      rest,
      search,
      port: found.info?.port,
      startedAt: found.info?.startedAt ?? 0,
    };
  }

  // ── HTTP forwarding ────────────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isWhitelistedHostHeader(req.headers.host)) {
      deny(res, 403, 'Forbidden');
      return;
    }
    const target = this.resolveTarget(req.url ?? '');
    if (!target) {
      // Unknown token / no token / malformed path — one generic answer.
      deny(res, 403, 'Forbidden');
      return;
    }
    if (target.rest !== VIEWER_HTTP_PATH || req.method !== 'GET') {
      // Authenticated session, but not a viewer endpoint: least privilege.
      deny(res, 404, 'Not found');
      return;
    }
    if (target.port === undefined) {
      // Known token, dead/starting Steel — explicit, fast. Any warmed key for
      // this session is stale from here on; drop it so the set cannot grow
      // unboundedly across respawns.
      diagWarn(`[browser-proxy] session ${target.sessionId} has no live Steel port; returning 503`);
      this.evictWarmedForSession(target.sessionId);
      unavailable(res);
      return;
    }
    const ready = await this.ensureWarmed(target);
    if (!ready) {
      unavailable(res);
      return;
    }
    this.forwardHttp(req, res, target);
  }

  private forwardHttp(req: IncomingMessage, res: ServerResponse, target: ViewerTarget): void {
    const port = target.port as number;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${port}`;
    delete headers.connection;
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/${target.rest}${target.search}`,
        method: req.method,
        headers,
        timeout: this.deps.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      diagWarn(`[browser-proxy] upstream error for session ${target.sessionId}:`, err.message);
      if (!res.headersSent) unavailable(res);
      res.end();
    });
    req.pipe(upstream);
  }

  /**
   * Cold-start gate (spike finding): Steel's health endpoint goes 200 before
   * the CDP wsEndpoint exists, and the viewer's first cast never retries — so
   * the first viewer load per process waits until the browser has a page.
   */
  private ensureWarmed(target: ViewerTarget): Promise<boolean> {
    const key = `${target.sessionId}:${target.startedAt}`;
    if (this.warmed.has(key)) return Promise.resolve(true);
    const inFlight = this.warming.get(key);
    if (inFlight) return inFlight;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const deadline = Date.now() + (this.deps.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS);
    const interval = this.deps.warmIntervalMs ?? DEFAULT_WARM_INTERVAL_MS;
    diagLog(`[browser-proxy] warming session ${target.sessionId} on port ${target.port}`);
    const attempt = (async () => {
      while (Date.now() < deadline) {
        try {
          const res = await fetchImpl(
            `http://127.0.0.1:${target.port}/v1/sessions/default/live-details`,
            { signal: AbortSignal.timeout(1_500) },
          );
          const body = (await res.json()) as { pages?: unknown[] };
          const pageCount = Array.isArray(body?.pages) ? body.pages.length : 0;
          if (pageCount > 0) {
            diagLog(
              `[browser-proxy] session ${target.sessionId} warmed (${pageCount} page(s))`,
            );
            this.warmed.add(key);
            while (this.warmed.size > MAX_WARMED_KEYS) {
              const oldest = this.warmed.keys().next().value;
              if (oldest === undefined) break;
              this.warmed.delete(oldest);
            }
            return true;
          }
          diagLog(
            `[browser-proxy] warm probe for ${target.sessionId}: ${pageCount} pages (status ${res.status})`,
          );
        } catch (err) {
          diagWarn(
            `[browser-proxy] warm probe for ${target.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      diagWarn(`[browser-proxy] warm-up timed out for session ${target.sessionId}`);
      return false;
    })();
    this.warming.set(key, attempt);
    return attempt.finally(() => {
      this.warming.delete(key);
    });
  }

  /** Drop all warmed keys for a session (its Steel process was observed dead). */
  private evictWarmedForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.warmed) {
      if (key.startsWith(prefix)) {
        this.warmed.delete(key);
      }
    }
  }

  // ── WebSocket upgrade forwarding (cast stream) ────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!isWhitelistedHostHeader(req.headers.host)) {
      denyUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const target = this.resolveTarget(req.url ?? '');
    if (!target) {
      denyUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (target.rest !== VIEWER_WS_PATH) {
      denyUpgrade(socket, 404, 'Not found');
      return;
    }
    if (target.port === undefined) {
      denyUpgrade(socket, 503, 'Browser unavailable');
      return;
    }
    const port = target.port;
    let connected = false;
    const upstream = net.connect(port, '127.0.0.1', () => {
      connected = true;
      // Re-issue the upgrade against Steel with the token prefix stripped.
      const lines = [`${req.method} /${target.rest}${target.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const value = /^host$/i.test(key) ? `127.0.0.1:${port}` : req.rawHeaders[i + 1];
        lines.push(`${key}: ${value}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
    });
    upstream.on('error', (err) => {
      if (!connected) {
        diagWarn(
          `[browser-proxy] cast upstream connect failed for session ${target.sessionId}: ${err.message}`,
        );
        denyUpgrade(socket, 503, 'Browser unavailable');
      } else {
        socket.destroy();
      }
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }
}

/**
 * Production singleton. server-main starts it before the first browser spawn
 * and stops it on shutdown; it self-registers the DOMAIN provider so every
 * Steel child is born pointing its viewer URLs at this proxy.
 */
export const browserViewerProxy = new BrowserViewerProxy({
  lookup: browserService,
  registerDomainProvider: (provider) => browserService.setViewerDomainProvider(provider),
});
