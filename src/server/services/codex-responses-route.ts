import { timingSafeEqual } from 'node:crypto';
import http, { type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { Router, type Request, type Response } from 'express';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface CodexResponsesRouteConfig {
  routeId: string;
  routeBearer: string;
  upstreamBaseUrl: string;
  providerBearer: string;
  maxBodyBytes?: number;
}

export interface CodexResponsesRouteController {
  router: Router;
  close(): void;
  status(): { activeRequests: number; closed: boolean };
}

export type CodexRouteAuthorization =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 404 | 405 };

export function authorizeCodexRouteRequest(input: {
  peerAddress: string | undefined;
  method: string;
  routeId: string;
  expectedRouteId: string;
  getAuthorization(): string | undefined;
  routeBearer: string;
}): CodexRouteAuthorization {
  // Peer validation intentionally precedes every request-derived value except
  // the socket address. A forged Host or Authorization header never advances
  // a non-loopback connection to body parsing.
  if (!input.peerAddress || !LOOPBACK_PEERS.has(input.peerAddress)) {
    return { allowed: false, status: 403 };
  }
  if (input.method !== 'POST') return { allowed: false, status: 405 };
  if (!safeEqual(input.routeId, input.expectedRouteId)) return { allowed: false, status: 404 };
  const authorization = input.getAuthorization();
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
  if (!match || !safeEqual(match[1], input.routeBearer)) return { allowed: false, status: 401 };
  return { allowed: true };
}

export function createCodexResponsesRoute(
  config: CodexResponsesRouteConfig,
): CodexResponsesRouteController {
  const upstreamUrl = responsesUrl(config.upstreamBaseUrl);
  const router = Router();
  const active = new Map<ClientRequest, () => void>();
  let activeRequests = 0;
  let closed = false;

  router.all('/:routeId/responses', (req, res) => {
    const decision = authorizeCodexRouteRequest({
      peerAddress: req.socket.remoteAddress,
      method: req.method,
      routeId: req.params.routeId,
      expectedRouteId: config.routeId,
      getAuthorization: () => req.headers.authorization,
      routeBearer: config.routeBearer,
    });
    if (!decision.allowed) {
      res.status(decision.status).end();
      return;
    }
    if (closed) {
      res.status(503).json({ error: 'route unavailable' });
      return;
    }
    proxyAuthenticatedRequest(req, res, upstreamUrl, config, active, () => {
      activeRequests += 1;
      return () => { activeRequests -= 1; };
    });
  });

  return {
    router,
    close() {
      if (closed) return;
      closed = true;
      for (const [request, settle] of active) {
        request.destroy();
        settle();
      }
      active.clear();
    },
    status: () => ({ activeRequests, closed }),
  };
}

export function codexResponsesRouteFromEnv(
  value: string | undefined,
): CodexResponsesRouteController | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid Codex route configuration');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Codex route configuration');
  const record = parsed as Record<string, unknown>;
  for (const field of ['routeId', 'routeBearer', 'upstreamBaseUrl', 'providerBearer'] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error('Invalid Codex route configuration');
    }
  }
  return createCodexResponsesRoute(record as unknown as CodexResponsesRouteConfig);
}

function proxyAuthenticatedRequest(
  req: Request,
  res: Response,
  upstreamUrl: URL,
  config: CodexResponsesRouteConfig,
  active: Map<ClientRequest, () => void>,
  startRequest: () => () => void,
): void {
  const maxBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let upstreamRequest: ClientRequest | undefined;
  const finish = startRequest();
  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (upstreamRequest) active.delete(upstreamRequest);
    finish();
  };
  const abort = (): void => {
    upstreamRequest?.destroy();
    settle();
  };
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      req.destroy();
      if (!res.headersSent) res.status(413).end();
      abort();
      return;
    }
    chunks.push(chunk);
  });
  req.once('end', () => {
    if (settled) return;
    const headers: IncomingHttpHeaders = {
      accept: req.headers.accept ?? 'text/event-stream',
      'content-type': req.headers['content-type'] ?? 'application/json',
      authorization: `Bearer ${config.providerBearer}`,
      'content-length': String(bytes),
    };
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    upstreamRequest = transport.request(upstreamUrl, { method: 'POST', headers }, (upstreamResponse) => {
      res.status(upstreamResponse.statusCode ?? 502);
      for (const name of ['content-type', 'cache-control']) {
        const value = upstreamResponse.headers[name];
        if (value !== undefined) res.setHeader(name, value);
      }
      upstreamResponse.once('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'upstream unavailable' });
        else res.end();
        settle();
      });
      upstreamResponse.once('end', settle);
      upstreamResponse.pipe(res);
    });
    active.set(upstreamRequest, settle);
    upstreamRequest.once('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'upstream unavailable' });
      else res.end();
      settle();
    });
    upstreamRequest.end(Buffer.concat(chunks));
  });
}

function responsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Codex route upstream must use HTTP or HTTPS');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/responses`;
  url.search = '';
  url.hash = '';
  return url;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
