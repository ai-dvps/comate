import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Router, type Request, type Response } from 'express';

import { converterLimits, ConverterError, safeUpstreamError } from './codex-chat-route/errors.js';
import { transformResponsesRequest } from './codex-chat-route/request-transform.js';
import { transformChatResponse } from './codex-chat-route/response-transform.js';
import { ChatSseToResponses, responsesFailedEvent } from './codex-chat-route/sse-transform.js';
import { byteLength, isRecord } from './codex-chat-route/shared.js';
import {
  authorizeBrowserRequest,
  defaultBrowserDnsResolver,
  resolveSafeDestination,
  siteBoundaryForUrl,
  type BrowserDnsResolver,
} from './browser-request-policy.js';
import {
  NodeDirectHttpsTransport,
  type DirectHttpTransport,
} from './browser-direct-http-client.js';
import { providerResourceUrl } from './provider-resolver.js';
import {
  ProviderRouteRegistry,
  ProviderRouteRegistryError,
  providerRouteRegistry,
  type AuthorizedProviderRoute,
  type ProviderRouteRequestHandle,
} from './provider-route-registry.js';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const REQUEST_HEADER_ALLOWLIST = new Set(['accept', 'content-type']);
const RESPONSE_HEADER_ALLOWLIST = new Set(['cache-control', 'content-type']);

export interface ProviderRouteUpstreamRequest {
  url: string;
  method: 'POST';
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  signal: AbortSignal;
}

export interface ProviderRouteUpstreamResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Buffer>;
  close(): void;
}

export interface ProviderRouteUpstreamTransport {
  request(input: ProviderRouteUpstreamRequest): Promise<ProviderRouteUpstreamResponse>;
}

export interface ProviderRouteHttpOptions {
  registry?: ProviderRouteRegistry;
  transport?: ProviderRouteUpstreamTransport;
  maxRequestBytes?: number;
}

export function isLoopbackPeer(address: string | undefined): boolean {
  return Boolean(address && LOOPBACK_PEERS.has(address));
}

export type ProviderRouteAuthorization =
  | { allowed: true; route: AuthorizedProviderRoute }
  | { allowed: false; status: 401 | 403 | 404 };

export function authorizeProviderRouteRequest(input: {
  peerAddress: string | undefined;
  method: string;
  routeId: string;
  getAuthorization(): string | undefined;
  registry: ProviderRouteRegistry;
}): ProviderRouteAuthorization {
  if (!isLoopbackPeer(input.peerAddress)) return { allowed: false, status: 403 };
  if (input.method !== 'POST') return { allowed: false, status: 404 };
  const bearer = extractBearer(input.getAuthorization());
  const route = bearer ? input.registry.authorize(input.routeId, bearer) : null;
  return route ? { allowed: true, route } : { allowed: false, status: 401 };
}

export function createProviderRouteHttpRouter(options: ProviderRouteHttpOptions = {}): Router {
  const registry = options.registry ?? providerRouteRegistry;
  const transport = options.transport ?? new PinnedHttpsProviderRouteTransport();
  const maxRequestBytes = options.maxRequestBytes ?? converterLimits().maxRequestBytes;
  const router = Router();

  router.all('/:routeId/responses', (req, res) => {
    // Socket identity, method, opaque path, and capability are all checked
    // before adding a body listener. Host/Origin are intentionally irrelevant.
    const decision = authorizeProviderRouteRequest({
      peerAddress: req.socket.remoteAddress,
      method: req.method,
      routeId: req.params.routeId,
      getAuthorization: () => req.headers.authorization,
      registry,
    });
    if (!decision.allowed) {
      res.status(decision.status).end();
      return;
    }
    void serveAuthorizedRequest(req, res, decision.route, registry, transport, maxRequestBytes);
  });
  // Close the entire mounted namespace. Unknown opaque paths must not fall
  // through to CORS or a generic body parser later in server-main.
  router.use((req, res) => {
    res.status(isLoopbackPeer(req.socket.remoteAddress) ? 404 : 403).end();
  });
  return router;
}

async function serveAuthorizedRequest(
  req: Request,
  res: Response,
  route: AuthorizedProviderRoute,
  registry: ProviderRouteRegistry,
  transport: ProviderRouteUpstreamTransport,
  maxRequestBytes: number,
): Promise<void> {
  let requestHandle: ProviderRouteRequestHandle | undefined;
  let upstream: ProviderRouteUpstreamResponse | undefined;
  let streamResponseId: string | undefined;
  let clientClosed = false;
  const closeClient = (): void => {
    if (!res.writableEnded) {
      clientClosed = true;
      requestHandle?.abort();
      upstream?.close();
    }
  };
  req.once('aborted', closeClient);
  res.once('close', closeClient);
  try {
    // Admit the active request before reading an authenticated body so a
    // single valid capability cannot create unbounded pre-admission buffers.
    requestHandle = registry.startRequest(route, 0);
    const raw = await readBoundedBody(req, maxRequestBytes, requestHandle.signal);
    let input: unknown;
    try {
      input = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ConverterError('invalid_request', 400);
    }
    const transformed = transformResponsesRequest(input, {
      providerId: route.upstream.providerId,
      credential: route.upstream.credential,
      sessionId: route.identity.sessionId,
      promptCacheRouting: route.upstream.promptCacheRouting,
      effortWireMapping: route.upstream.effortWireMapping,
      suppressSamplingParameters: route.upstream.suppressSamplingParameters,
      limits: route.upstream.converterLimits,
    });
    transformed.body.model = route.upstream.model;
    const historyBytes = byteLength(transformed.body.messages ?? []);
    requestHandle.reserveHistory(historyBytes);
    if (clientClosed) requestHandle.abort();

    const body = Buffer.from(JSON.stringify(transformed.body));
    if (body.byteLength > converterLimits(route.upstream.converterLimits).maxRequestBytes) {
      throw new ConverterError('request_too_large', 413);
    }
    const url = providerResourceUrl(route.upstream.baseUrl, 'chat/completions');
    upstream = await transport.request({
      url,
      method: 'POST',
      headers: allowlistedRequestHeaders(req.headers, route.upstream.credential, body.byteLength),
      body,
      signal: requestHandle.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) throw safeUpstreamError({ status: 500 });
    if (upstream.status < 200 || upstream.status >= 300) throw safeUpstreamError({ status: upstream.status });
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) res.setHeader(name, value);
    }
    if (transformed.body.stream === true) {
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      streamResponseId = `resp_${randomBytes(16).toString('hex')}`;
      const converter = new ChatSseToResponses({
        responseId: streamResponseId,
        model: route.upstream.model,
        toolNames: transformed.toolNames,
        limits: route.upstream.converterLimits,
      });
      for await (const chunk of upstream.body) {
        // Retain an aggregate reservation for every consumed upstream byte
        // until conversion completes. This bounds decoder + accumulated
        // reasoning/text/tool state across all leases, not only socket writes.
        requestHandle.reserveBuffered(chunk.byteLength);
        for (const event of converter.push(chunk)) await writeBounded(res, requestHandle, event);
      }
      for (const event of converter.finish()) await writeBounded(res, requestHandle, event);
      res.end();
    } else {
      const responseBody = await collectBounded(upstream.body, converterLimits(route.upstream.converterLimits).maxResponseBytes, requestHandle);
      let decoded: unknown;
      try {
        decoded = JSON.parse(responseBody.toString('utf8'));
      } catch {
        throw new ConverterError('unsupported_event', 502);
      }
      const output = Buffer.from(JSON.stringify(transformChatResponse(decoded, {
        toolNames: transformed.toolNames,
        limits: route.upstream.converterLimits,
      })));
      res.status(200).type('application/json');
      await writeBounded(res, requestHandle, output);
      res.end();
    }
  } catch (error) {
    if (!clientClosed && !res.headersSent) sendSafeError(res, error);
    else if (!clientClosed && !res.writableEnded) {
      if (streamResponseId && requestHandle) {
        const safe = error instanceof ConverterError
          ? error
          : safeUpstreamError({
              timeout: isRecord(error) && error.name === 'TimeoutError',
              network: true,
            });
        await writeBounded(res, requestHandle, responsesFailedEvent({
          responseId: streamResponseId,
          model: route.upstream.model,
          error: safe,
        })).catch(() => undefined);
      }
      res.end();
    }
  } finally {
    upstream?.close();
    requestHandle?.finish();
    req.off('aborted', closeClient);
    res.off('close', closeClient);
  }
}

function extractBearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '');
  return match?.[1] ?? null;
}

function allowlistedRequestHeaders(
  incoming: IncomingHttpHeaders,
  credential: string,
  contentLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) continue;
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  headers.accept = headers.accept ?? 'text/event-stream, application/json';
  headers['content-type'] = 'application/json';
  headers['content-length'] = String(contentLength);
  headers.authorization = `Bearer ${credential}`;
  return headers;
}

async function readBoundedBody(req: Request, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const abort = (): void => {
    req.destroy();
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new ConverterError('request_too_large', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function collectBounded(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
  handle: ProviderRouteRequestHandle,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new ConverterError('response_too_large', 502);
      handle.reserveBuffered(chunk.byteLength);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    handle.releaseBuffered(bytes);
  }
}

async function writeBounded(
  res: Response,
  handle: ProviderRouteRequestHandle,
  value: string | Buffer,
): Promise<void> {
  const bytes = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value);
  handle.reserveBuffered(bytes);
  await new Promise<void>((resolve, reject) => {
    res.write(value, (error) => error ? reject(error) : resolve());
  }).finally(() => handle.releaseBuffered(bytes));
}

function sendSafeError(res: Response, error: unknown): void {
  if (error instanceof ConverterError) {
    res.status(error.status).json(error.toResponsesError());
    return;
  }
  if (error instanceof ProviderRouteRegistryError) {
    const status = error.code === 'route_unavailable' ? 503 : 429;
    res.status(status).json({ error: { type: error.code, code: error.code, message: error.message } });
    return;
  }
  const safe = safeUpstreamError({
    timeout: isRecord(error) && error.name === 'TimeoutError',
    network: true,
  });
  res.status(safe.status).json(safe.toResponsesError());
}

function normalizedHeaders(
  headers: IncomingHttpHeaders | Record<string, string | readonly string[] | undefined>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') output[name.toLowerCase()] = value;
    else if (Array.isArray(value)) output[name.toLowerCase()] = value.join(', ');
  }
  return output;
}

/**
 * Streaming counterpart of BrowserDirectHttpClient's shared Provider egress
 * policy: HTTPS only, every DNS answer public, one pinned address, original
 * hostname for SNI/certificate validation, no Agent/proxy inheritance, and no
 * redirect following.
 */
export class PinnedHttpsProviderRouteTransport implements ProviderRouteUpstreamTransport {
  private readonly resolver: BrowserDnsResolver;
  private readonly transport: DirectHttpTransport;
  private readonly totalTimeoutMs: number;

  constructor(options?: {
    resolver?: BrowserDnsResolver;
    transport?: DirectHttpTransport;
    totalTimeoutMs?: number;
  }) {
    this.resolver = options?.resolver ?? defaultBrowserDnsResolver;
    this.transport = options?.transport ?? new NodeDirectHttpsTransport();
    this.totalTimeoutMs = options?.totalTimeoutMs ?? 60_000;
  }

  async request(input: ProviderRouteUpstreamRequest): Promise<ProviderRouteUpstreamResponse> {
    const authorized = authorizeBrowserRequest({
      url: input.url,
      authorizedDomain: siteBoundaryForUrl(input.url),
      method: input.method,
      headers: Object.entries(input.headers).filter(([name]) => REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())),
      body: input.body,
      limits: { maxRequestBytes: converterLimits().maxRequestBytes },
    });
    const destination = await resolveSafeDestination(authorized, this.resolver);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.totalTimeoutMs);
    try {
      const response = await this.transport.request({
        hostname: destination.hostname,
        servername: destination.hostname,
        pinnedAddress: destination.address,
        family: destination.family,
        port: destination.port,
        path: `${authorized.url.pathname}${authorized.url.search}`,
        method: 'POST',
        headers: { ...input.headers },
        body: input.body,
        signal: controller.signal,
        connectTimeoutMs: 5_000,
        headerTimeoutMs: 15_000,
        inactivityTimeoutMs: 30_000,
      });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        response.close();
      };
      const body = (async function* (): AsyncIterable<Buffer> {
        try {
          for await (const chunk of response.body) yield chunk;
        } catch (error) {
          if (timedOut) throw Object.assign(new Error('Provider route timed out'), { name: 'TimeoutError' });
          throw error;
        } finally {
          close();
        }
      })();
      return {
        status: response.statusCode,
        headers: normalizedHeaders(response.headers),
        body,
        close,
      };
    } catch (error) {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      if (timedOut) throw Object.assign(new Error('Provider route timed out'), { name: 'TimeoutError' });
      throw error;
    }
  }
}
