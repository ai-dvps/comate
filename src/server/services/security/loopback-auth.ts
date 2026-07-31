/**
 * loopback-auth (U12, KTD-28) — default-deny authentication for the whole
 * `/api` surface at the route-registration layer.
 *
 * The problem this closes: sandbox-reachable (loopback) routes were an OPEN
 * set of unauthenticated endpoints — `wecom/send` trusted a self-asserted
 * sessionId, `files/content` read any workspace path, and every FUTURE route
 * would have been born unauthenticated. The structural fix:
 *
 *  1. Every request under `/api` must present a Bearer credential — either
 *     the desktop GUI credential (full surface) or a per-session capability
 *     token. New routes are protected by default; exemption requires editing
 *     the explicit EXEMPT_PATHS list in this file.
 *  2. Session capability tokens only reach a CLOSED, explicitly enrolled set
 *     of route templates (the wecom CLI surface). A session token presented
 *     anywhere else — including routes that do not exist yet — gets 403.
 *  3. Identity flows from the token: enrolled templates capture
 *     `:workspaceId` (and `:sessionId` where present) and the middleware
 *     rejects any mismatch against the token's binding, so a stolen token
 *     cannot be pointed at another workspace, and a self-asserted sessionId
 *     in the path cannot impersonate another session.
 *
 * Exemption list (the entire unauthenticated surface by design):
 *  - `/api/health` — liveness probe, returns `{status:'ok'}`, no data.
 *  - `/mcp/browser`, `/mcp/scheduled-tasks` — mounted outside `/api` with
 *    their own per-sidecar Bearer tokens (pre-guard mounts in server-main).
 *  - `/shutdown` — outside `/api`, guarded by its own loopback-IP check.
 *  No bot-platform webhook exemptions exist: WeCom/Feishu make OUTBOUND
 *  long-connections; no inbound webhook ever lands on this app (see
 *  request-origin-guard.ts "Bot callbacks").
 *
 * The middleware NEVER logs the Authorization header or token values.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { diagLog } from '../../utils/diag-logger.js';

export type LoopbackAuthContext =
  | { kind: 'desktop' }
  | { kind: 'session'; sessionId: string; workspaceId: string; botId: string | null };

export interface SessionTokenResolution {
  sessionId: string;
  workspaceId: string;
  botId: string | null;
}

export interface LoopbackAuthDeps {
  /** Resolve a presented session capability token; null when invalid/expired/revoked. */
  resolveSessionToken: (token: string) => SessionTokenResolution | null;
  /** The current desktop GUI credential (null before boot minting completes). */
  getDesktopToken: () => string | null;
  /** Unauthenticated paths (exact match, method-agnostic). Defaults to EXEMPT_PATHS. */
  exemptPaths?: readonly string[];
  /** Session-token-reachable templates. Defaults to SESSION_ROUTE_TEMPLATES. */
  sessionRoutes?: readonly string[];
}

/** The complete unauthenticated `/api` surface (U12). Everything else requires a credential. */
export const EXEMPT_PATHS: readonly string[] = ['/api/health'];

/**
 * The closed set of route templates a per-session capability token may reach.
 * `:workspaceId` and `:sessionId` captures are semantically bound to the
 * token — mismatches are rejected with 403.
 */
export const SESSION_ROUTE_TEMPLATES: readonly string[] = [
  'POST /api/workspaces/:workspaceId/wecom/send',
  'POST /api/workspaces/:workspaceId/wecom/send-file',
  'POST /api/workspaces/:workspaceId/wecom/doc/:tool',
  'POST /api/workspaces/:workspaceId/wecom/smartsheet-export',
  'GET /api/workspaces/:workspaceId/sessions/:sessionId/wecom-user',
];

const AUTH_CONTEXT_KEY = 'loopbackAuth';

type AuthedRequest = Request & { [AUTH_CONTEXT_KEY]?: LoopbackAuthContext };

/** Accessor for handlers: the auth context stamped by the middleware. */
export function getLoopbackAuth(req: Request): LoopbackAuthContext | undefined {
  return (req as AuthedRequest)[AUTH_CONTEXT_KEY];
}

/**
 * Guard for session-capability route handlers: requires a session-kind auth
 * context (the CLI). Desktop credential callers get 403 — these routes derive
 * identity from the bound session, and the desktop client has no session.
 * Writes the error response and returns null on failure.
 */
export function requireSessionAuth(
  req: Request,
  res: Response,
): { sessionId: string; workspaceId: string; botId: string | null } | null {
  const auth = getLoopbackAuth(req);
  if (!auth || auth.kind !== 'session') {
    res.status(403).json({ error: 'forbidden', message: 'This route requires a session capability token.' });
    return null;
  }
  return auth;
}

interface CompiledTemplate {
  method: string;
  segments: string[];
}

function compileTemplate(template: string): CompiledTemplate {
  const [method, ...rest] = template.split(' ');
  const pathPart = rest.join(' ');
  return {
    method: method.toUpperCase(),
    segments: pathPart.split('/').filter((seg) => seg.length > 0),
  };
}

function normalizePath(rawPath: string): string {
  if (rawPath.length > 1 && rawPath.endsWith('/')) {
    return rawPath.slice(0, -1);
  }
  return rawPath;
}

function safeTokenEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Match a request against the enrolled session-route templates. Returns the
 * captured params on match, null otherwise. Capture names are semantic
 * anchors (`:workspaceId`, `:sessionId`), independent of the router's own
 * param names.
 */
function matchSessionRoute(
  method: string,
  path: string,
  templates: readonly string[],
): Record<string, string> | null {
  const segments = path.split('/').filter((seg) => seg.length > 0);
  for (const template of templates) {
    const compiled = compileTemplate(template);
    if (compiled.method !== method.toUpperCase()) continue;
    if (compiled.segments.length !== segments.length) continue;
    const captures: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < compiled.segments.length; i++) {
      const want = compiled.segments[i];
      const got = segments[i];
      if (want.startsWith(':')) {
        if (got.length === 0) {
          matched = false;
          break;
        }
        captures[want.slice(1)] = decodeURIComponent(got);
        continue;
      }
      if (want !== got) {
        matched = false;
        break;
      }
    }
    if (matched) return captures;
  }
  return null;
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'unauthorized', message: 'A valid Bearer credential is required.' });
}

function forbidden(res: Response, message: string): void {
  res.status(403).json({ error: 'forbidden', message });
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The default-deny `/api` authentication middleware. Mount ONCE at the app
 * level before any route registration — every `/api` route (present and
 * future) is then authenticated by construction.
 */
export function createLoopbackAuthMiddleware(deps: LoopbackAuthDeps): RequestHandler {
  const exemptPaths = new Set(deps.exemptPaths ?? EXEMPT_PATHS);
  const sessionRoutes = deps.sessionRoutes ?? SESSION_ROUTE_TEMPLATES;

  return (req: Request, res: Response, next: NextFunction) => {
    const path = normalizePath(req.path);

    // Only the /api surface is governed here. /mcp/* mounts carry their own
    // Bearer tokens; /shutdown has its loopback-IP guard; static assets and
    // the SPA shell are public-by-design (they hold no data).
    if (path !== '/api' && !path.startsWith('/api/')) {
      next();
      return;
    }

    if (exemptPaths.has(path)) {
      next();
      return;
    }

    const token = extractBearer(req);
    if (!token) {
      diagLog(`[loopback-auth] 401 ${req.method} ${path}: missing bearer credential`);
      unauthorized(res);
      return;
    }

    const desktopToken = deps.getDesktopToken();
    if (desktopToken && safeTokenEqual(token, desktopToken)) {
      (req as AuthedRequest)[AUTH_CONTEXT_KEY] = { kind: 'desktop' };
      next();
      return;
    }

    const session = deps.resolveSessionToken(token);
    if (!session) {
      diagLog(`[loopback-auth] 401 ${req.method} ${path}: invalid, expired, or revoked session token`);
      unauthorized(res);
      return;
    }

    const captures = matchSessionRoute(req.method, path, sessionRoutes);
    if (!captures) {
      diagLog(
        `[loopback-auth] 403 ${req.method} ${path}: session token outside the enrolled route set (session=${session.sessionId})`,
      );
      forbidden(res, 'Session capability tokens may only call the enrolled CLI route set.');
      return;
    }
    if (captures.workspaceId !== undefined && captures.workspaceId !== session.workspaceId) {
      diagLog(
        `[loopback-auth] 403 ${req.method} ${path}: token workspace mismatch (session=${session.sessionId})`,
      );
      forbidden(res, 'Token is not valid for this workspace.');
      return;
    }
    if (captures.sessionId !== undefined && captures.sessionId !== session.sessionId) {
      diagLog(
        `[loopback-auth] 403 ${req.method} ${path}: token session mismatch (session=${session.sessionId})`,
      );
      forbidden(res, 'Token is not valid for this session.');
      return;
    }

    (req as AuthedRequest)[AUTH_CONTEXT_KEY] = {
      kind: 'session',
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      botId: session.botId,
    };
    next();
  };
}
