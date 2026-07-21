import type { IncomingMessage } from 'http';
import type { Request, RequestHandler } from 'express';
import { diagLog } from '../../utils/diag-logger.js';

/**
 * Request origin guard (plan U9, R12 groundwork).
 *
 * Shrinks the sidecar's remote attack surface before the approval hard-gate
 * and viewer-token units land, without changing any functional semantics —
 * the guard only adds source validation:
 *
 *  1. CORS matrix (`createCorsOriginCallback`) — replaces `cors()` (allow-*)
 *     with the per-platform app origin matrix. Cross-origin pages (a
 *     "passing-by" website open in a browser) can no longer read API
 *     responses, and their preflighted mutations never get sent.
 *  2. Host header whitelist (`hostHeaderGuard`) — anti-DNS-rebinding for ALL
 *     routes including reads: only loopback/tauri hostnames are served, so a
 *     rebound hostname cannot turn the sidecar into a same-origin target.
 *  3. State-changing source check (`stateChangingRequestGuard`) — non-GET
 *     requests (approval resolution et al.) must come from the app origin
 *     matrix or from a header-less local client. This is the layer that stops
 *     simple (non-preflighted) cross-site form POSTs, which CORS cannot stop.
 *  4. WS upgrade source check (`createWsUpgradeVerifier`) — same evaluation
 *     for the /ws upgrade handshake.
 *
 * ── Origin matrix ────────────────────────────────────────────────────────────
 *  - `tauri://localhost`        macOS/Linux production webview (Tauri custom scheme)
 *  - `http://tauri.localhost`   Windows production (WebView2)
 *  - `https://tauri.localhost`  Windows production (https variant)
 *  - `http://localhost:5173`    dev vite origin (forwarded as-is through the
 *                               vite proxy, which only rewrites Host)
 *  - self origin (`http://localhost:<port>` / `http://127.0.0.1:<port>`) — the
 *    sidecar also serves the built UI statically in production, so a browser
 *    pointed straight at the sidecar port must keep working. Safe because the
 *    Host whitelist already guarantees such a page was served by us.
 *
 * ── null-Origin / absent-Origin policy (settled by real webview capture) ────
 * Captured 2026-07-19 against a WKWebView serving a `tauri://localhost` page
 * (custom URL scheme handler, mirroring Tauri on macOS): fetch GET, fetch POST
 * (with preflight) and WebSocket upgrade ALL send `Origin: tauri://localhost`
 * AND `Sec-Fetch-Site: cross-site` (a custom scheme is cross-site to loopback
 * http). Consequences:
 *  - The matrix check must ignore Sec-Fetch-Site when Origin is present —
 *    the legitimate macOS client is itself "cross-site" by Fetch Metadata.
 *  - `Origin: null` is REJECTED on state-changing requests and WS upgrades.
 *    Legit webviews never produce it (macOS evidence above; WebView2 page
 *    origins are plain http(s) and serialize normally), while sandboxed
 *    iframes / data: URLs — a classic CSRF vehicle — serialize as `null`.
 *  - Windows WebView2 was not measurable in this environment; its origins are
 *    ordinary http(s), where Chromium always sends Origin on cross-site
 *    fetch POST and WS upgrade, so the same policy holds by construction.
 *
 * Absent Origin (truly no header) means a non-browser local client: the Tauri
 * shell's reqwest calls (e.g. POST /shutdown), wecom plugin/skill scripts
 * (POST /api/wecom/resolve-user), the wecom CLI, curl. Browsers always attach
 * Origin to cross-site fetch POSTs and WS upgrades, so this cannot be a
 * passing-by page. Conservative rule (sanctioned by the plan): allow only when
 * the Host is whitelisted AND Sec-Fetch-Site is absent or not `cross-site`.
 * Residual, accepted and documented: a legacy browser sending neither Origin
 * nor Fetch Metadata on a cross-site POST form would pass — no such browser is
 * a supported client, and modern Safari/Chrome/Firefox all send Origin there.
 *
 * ── Bot callbacks ────────────────────────────────────────────────────────────
 * No exemption list is required: WeCom and Feishu integrations make OUTBOUND
 * long-connections (WeCom long-poll, Lark WSClient) — no bot platform webhook
 * ever lands on this Express app. The only inbound server-to-server callers
 * are the local processes above, which pass the absent-Origin rule.
 */

export interface OriginGuardOptions {
  /**
   * Returns the port the sidecar itself is listening on, used to allow the
   * self origin (browser pointed at the statically served UI). May return
   * undefined before the listener is bound; requests cannot arrive before
   * that, so in practice it is always set when evaluated.
   */
  getSelfPort?: () => number | undefined;
}

const ALLOWED_APP_ORIGINS: readonly string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
];

const WHITELISTED_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'tauri.localhost',
]);

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestHeaderView {
  origin?: string | undefined;
  host?: string | undefined;
  secFetchSite?: string | undefined;
}

export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Extracts the bare hostname from a Host header value: lowercased, one
 * trailing dot stripped, port removed (bracketed IPv6 supported). Returns
 * null for missing/empty/malformed input (e.g. a non-numeric port, userinfo
 * tricks like `localhost:3000@evil.com`) so callers fail closed.
 */
export function parseHostHeader(hostHeader: string | undefined | null): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  const stripTrailingDot = (hostname: string): string =>
    hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    const rest = value.slice(close + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return null;
    return value.slice(1, close);
  }
  const firstColon = value.indexOf(':');
  if (firstColon === -1) return stripTrailingDot(value);
  if (value.indexOf(':', firstColon + 1) !== -1) {
    // Multiple colons without brackets: bare IPv6 literal — take whole value.
    return value;
  }
  if (!/^\d+$/.test(value.slice(firstColon + 1))) return null;
  return stripTrailingDot(value.slice(0, firstColon));
}

export function isWhitelistedHostHeader(hostHeader: string | undefined | null): boolean {
  const hostname = parseHostHeader(hostHeader);
  return hostname !== null && WHITELISTED_HOSTNAMES.has(hostname);
}

export function isAllowedAppOrigin(origin: string, selfPort?: number): boolean {
  if (ALLOWED_APP_ORIGINS.includes(origin)) return true;
  if (selfPort !== undefined) {
    return origin === `http://localhost:${selfPort}` || origin === `http://127.0.0.1:${selfPort}`;
  }
  return false;
}

/**
 * Shared source evaluation for state-changing HTTP requests and WS upgrades.
 * Order matters: Host first (anti-rebinding), then the Origin matrix, with
 * the absent/null-Origin policy documented at the top of this file.
 */
export function evaluateRequestSource(
  headers: RequestHeaderView,
  selfPort?: number,
): GuardDecision {
  if (!isWhitelistedHostHeader(headers.host)) {
    return { allowed: false, reason: 'host-not-whitelisted' };
  }

  const origin = headers.origin;
  if (origin === undefined || origin === '') {
    if (headers.secFetchSite?.toLowerCase() === 'cross-site') {
      return { allowed: false, reason: 'cross-site-without-origin' };
    }
    return { allowed: true };
  }
  if (origin === 'null') {
    return { allowed: false, reason: 'null-origin' };
  }
  if (isAllowedAppOrigin(origin, selfPort)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'origin-not-allowed' };
}

function headerViewFromRequest(req: Request): RequestHeaderView {
  return {
    origin: req.headers.origin,
    host: req.headers.host,
    secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
  };
}

/**
 * Rejects any request whose Host is not loopback/tauri — mount FIRST, before
 * CORS and routes. Applies to reads too (DNS-rebinding defense).
 */
export function hostHeaderGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isWhitelistedHostHeader(req.headers.host)) {
      diagLog(
        `[origin-guard] rejected ${req.method} ${req.path}: host '${req.headers.host ?? ''}' not whitelisted`,
      );
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

/**
 * Rejects cross-source state-changing requests (POST/PUT/PATCH/DELETE) —
 * approval resolution and friends. Safe methods pass through untouched.
 */
export function stateChangingRequestGuard(options: OriginGuardOptions = {}): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const decision = evaluateRequestSource(headerViewFromRequest(req), options.getSelfPort?.());
    if (!decision.allowed) {
      diagLog(
        `[origin-guard] rejected ${req.method} ${req.path}: ${decision.reason} ` +
          `(origin=${req.headers.origin ?? 'none'})`,
      );
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

/**
 * Origin callback for the `cors` package implementing the app origin matrix.
 * Disallowed origins get NO CORS headers at all (the cors package skips
 * header emission entirely), so cross-origin reads stay unreadable and
 * preflights fail. Requests without an Origin header are non-browser or
 * same-origin — CORS is moot for them, so we allow (no ACAO is emitted).
 */
export function createCorsOriginCallback(
  options: OriginGuardOptions = {},
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isAllowedAppOrigin(origin, options.getSelfPort?.()));
  };
}

interface WsUpgradeVerifyInfo {
  origin: string;
  secure: boolean;
  req: IncomingMessage;
}

/**
 * `verifyClient` (async form) for the ws WebSocketServer: applies the same
 * source evaluation to the /ws upgrade handshake. The Express middleware
 * stack never sees upgrade requests, so the Host whitelist is re-checked here.
 */
export function createWsUpgradeVerifier(
  options: OriginGuardOptions = {},
): (info: WsUpgradeVerifyInfo, callback: (result: boolean, code?: number, message?: string) => void) => void {
  return (info, callback) => {
    const headers: RequestHeaderView = {
      origin: info.req.headers.origin,
      host: info.req.headers.host,
      secFetchSite: info.req.headers['sec-fetch-site'] as string | undefined,
    };
    const decision = evaluateRequestSource(headers, options.getSelfPort?.());
    if (!decision.allowed) {
      diagLog(
        `[origin-guard] rejected WS upgrade: ${decision.reason} ` +
          `(origin=${info.origin ?? 'none'}, host=${headers.host ?? 'none'})`,
      );
      callback(false, 403, 'Forbidden');
      return;
    }
    callback(true);
  };
}
