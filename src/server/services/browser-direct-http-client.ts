import http, { type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import {
  BrowserRequestPolicyError,
  authorizeBrowserRequest,
  authorizeProviderRequest,
  containsControlCharacter,
  defaultBrowserDnsResolver,
  resolveSafeDestination,
  resolveProviderDestination,
  siteBoundaryForUrl,
  type AuthorizedBrowserRequest,
  type BrowserDnsResolver,
  type BrowserRequestPolicyErrorCode,
  type SafeDestination,
} from './browser-request-policy.js';

export type BrowserDirectHttpErrorCode =
  | BrowserRequestPolicyErrorCode
  | 'redirect_loop'
  | 'redirect_limit_exceeded'
  | 'invalid_redirect'
  | 'redirect_not_allowed'
  | 'response_limit_exceeded'
  | 'unsupported_content_encoding'
  | 'request_timeout'
  | 'request_aborted'
  | 'concurrency_limit_exceeded'
  | 'transport_error';

export class BrowserDirectHttpError extends Error {
  constructor(readonly code: BrowserDirectHttpErrorCode, message: string) {
    super(message);
    this.name = 'BrowserDirectHttpError';
  }
}

export interface DirectHttpTransportRequest {
  protocol?: 'http:' | 'https:';
  hostname: string;
  servername: string;
  pinnedAddress: string;
  family: 4 | 6;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  connectTimeoutMs: number;
  headerTimeoutMs: number;
  inactivityTimeoutMs: number;
}

export interface DirectHttpTransportResponse {
  statusCode: number;
  headers: Record<string, string | readonly string[] | undefined>;
  body: AsyncIterable<Buffer>;
  close(): void;
}

export interface DirectHttpTransport {
  request(input: DirectHttpTransportRequest): Promise<DirectHttpTransportResponse>;
}

export interface BrowserDirectHttpLimits {
  maxConcurrent: number;
  maxRedirects: number;
  maxRequestBytes: number;
  maxResponseWireBytes: number;
  maxResponseDecodedBytes: number;
  maxDecompressionRatio: number;
  connectTimeoutMs: number;
  headerTimeoutMs: number;
  inactivityTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface BrowserDirectHttpRequest {
  url: string;
  /** Browser requests set this explicitly. Provider egress derives it from the validated URL. */
  authorizedDomain?: string;
  redirectPolicy?: 'follow' | 'error';
  /** Explicit Provider configuration may target private HTTP(S) services. */
  destinationPolicy?: 'public-https' | 'provider';
  method: string;
  headers?: Record<string, string> | ReadonlyArray<readonly [string, string]>;
  body?: string | Buffer;
  signal?: AbortSignal;
  /** U5 hook: selected only after this hop passes URL + all-answer DNS policy. */
  prepareHopHeaders?: (
    request: AuthorizedBrowserRequest,
    destination: SafeDestination,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

export interface BrowserDirectHttpResult {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  redirects: Array<{ status: number; from: string; to: string; method: string }>;
}

export interface BrowserDirectHttpClientOptions {
  resolver?: BrowserDnsResolver;
  transport?: DirectHttpTransport;
  limits?: Partial<BrowserDirectHttpLimits>;
}

const DEFAULT_LIMITS: BrowserDirectHttpLimits = {
  maxConcurrent: 4,
  maxRedirects: 5,
  maxRequestBytes: 1024 * 1024,
  maxResponseWireBytes: 2 * 1024 * 1024,
  maxResponseDecodedBytes: 4 * 1024 * 1024,
  maxDecompressionRatio: 100,
  connectTimeoutMs: 5_000,
  headerTimeoutMs: 10_000,
  inactivityTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
};

function limitsFor(partial?: Partial<BrowserDirectHttpLimits>): BrowserDirectHttpLimits {
  const limits = { ...DEFAULT_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BrowserDirectHttpError('invalid_request', `${name} must be positive`);
    }
  }
  return limits;
}

function responseHeaders(headers: IncomingHttpHeaders | DirectHttpTransportResponse['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') output[name.toLowerCase()] = value;
    else if (Array.isArray(value)) output[name.toLowerCase()] = value.join(', ');
    else if (typeof value === 'number') output[name.toLowerCase()] = String(value);
  }
  return output;
}

/** Direct pinned HTTP(S) transport; callers remain responsible for destination policy. */
export class NodeDirectHttpTransport implements DirectHttpTransport {
  request(input: DirectHttpTransportRequest): Promise<DirectHttpTransportResponse> {
    const protocol = input.protocol ?? 'https:';
    const client = protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      let connectTimer: NodeJS.Timeout | undefined;
      const options: RequestOptions = {
        protocol,
        hostname: input.hostname,
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers,
        signal: input.signal,
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: input.pinnedAddress, family: input.family }]);
          else callback(null, input.pinnedAddress, input.family);
        },
        ...(protocol === 'https:' ? { servername: input.servername } : {}),
      };
      const req = client.request(options, (res) => {
        if (headerTimer) clearTimeout(headerTimer);
        if (connectTimer) clearTimeout(connectTimer);
        res.setTimeout(input.inactivityTimeoutMs, () => {
          res.destroy(new BrowserDirectHttpError('request_timeout', 'Response inactivity timeout'));
        });
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: res as AsyncIterable<Buffer>,
          close: () => res.destroy(),
        });
      });
      req.once('socket', (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => {
          req.destroy(new BrowserDirectHttpError('request_timeout', 'Connect timeout'));
        }, input.connectTimeoutMs);
        socket.once(protocol === 'https:' ? 'secureConnect' : 'connect', () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
      });
      const headerTimer = setTimeout(() => {
        req.destroy(new BrowserDirectHttpError('request_timeout', 'Response header timeout'));
      }, input.headerTimeoutMs);
      req.once('error', (error) => {
        if (headerTimer) clearTimeout(headerTimer);
        if (connectTimer) clearTimeout(connectTimer);
        reject(error);
      });
      if (input.body) req.write(input.body);
      req.end();
    });
  }
}

function redirectMethod(status: number, method: string, body: Buffer | undefined): { method: string; body?: Buffer } {
  if (status === 303 && method !== 'HEAD') return { method: 'GET' };
  if ((status === 301 || status === 302) && method === 'POST') return { method: 'GET' };
  return { method, ...(body ? { body } : {}) };
}

function abortError(timedOut: boolean): BrowserDirectHttpError {
  return timedOut
    ? new BrowserDirectHttpError('request_timeout', 'Request exceeded its total time limit')
    : new BrowserDirectHttpError('request_aborted', 'Request was aborted');
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw abortError(timedOut());
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => reject(abortError(timedOut()));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function promiseWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<T> {
  if (signal.aborted) throw abortError(timedOut());
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(timedOut()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readWireBody(
  response: DirectHttpTransportResponse,
  signal: AbortSignal,
  timedOut: () => boolean,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextWithAbort(iterator, signal, timedOut);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new BrowserDirectHttpError('response_limit_exceeded', 'Response wire bytes exceed limit');
      }
      chunks.push(chunk);
    }
  } finally {
    if (iterator.return) await iterator.return().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

function decodeBody(
  wire: Buffer,
  contentEncoding: string | undefined,
  limits: BrowserDirectHttpLimits,
): Buffer {
  const encoding = contentEncoding?.trim().toLowerCase();
  let decoded: Buffer;
  try {
    if (!encoding || encoding === 'identity') decoded = wire;
    else if (encoding === 'gzip' || encoding === 'x-gzip') {
      decoded = gunzipSync(wire, { maxOutputLength: limits.maxResponseDecodedBytes });
    } else if (encoding === 'deflate') {
      decoded = inflateSync(wire, { maxOutputLength: limits.maxResponseDecodedBytes });
    } else if (encoding === 'br') {
      decoded = brotliDecompressSync(wire, { maxOutputLength: limits.maxResponseDecodedBytes });
    } else {
      throw new BrowserDirectHttpError('unsupported_content_encoding', 'Response content encoding is unsupported');
    }
  } catch (error) {
    if (error instanceof BrowserDirectHttpError) throw error;
    throw new BrowserDirectHttpError('response_limit_exceeded', 'Compressed response could not be decoded within limits');
  }
  if (decoded.byteLength > limits.maxResponseDecodedBytes) {
    throw new BrowserDirectHttpError('response_limit_exceeded', 'Decoded response exceeds limit');
  }
  if (wire.byteLength > 0 && decoded.byteLength / wire.byteLength > limits.maxDecompressionRatio) {
    throw new BrowserDirectHttpError('response_limit_exceeded', 'Response decompression ratio exceeds limit');
  }
  return decoded;
}

function validateHookHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  const forbidden = /^(?:host|content-length|transfer-encoding|connection|trailer|upgrade|proxy-|forwarded|x-forwarded-|via|te|expect)$/i;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(rawName) || containsControlCharacter(value) || forbidden.test(name)) {
      throw new BrowserDirectHttpError('invalid_request', 'Broker header hook returned an unsafe header');
    }
    output[name] = value;
  }
  return output;
}

export class BrowserDirectHttpClient {
  private readonly resolver: BrowserDnsResolver;
  private readonly transport: DirectHttpTransport;
  private readonly limits: BrowserDirectHttpLimits;
  private active = 0;

  constructor(options: BrowserDirectHttpClientOptions = {}) {
    this.resolver = options.resolver ?? defaultBrowserDnsResolver;
    this.transport = options.transport ?? new NodeDirectHttpTransport();
    this.limits = limitsFor(options.limits);
  }

  async request(input: BrowserDirectHttpRequest): Promise<BrowserDirectHttpResult> {
    if (this.active >= this.limits.maxConcurrent) {
      throw new BrowserDirectHttpError('concurrency_limit_exceeded', 'Direct HTTP concurrency limit reached');
    }
    this.active += 1;
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    // Watchdog timers stay ref'd: a caller awaiting the request may hold no
    // other loop handle (fake transports in tests, one-shot scripts), and an
    // unref'd watchdog would let the loop drain and strand the await. Bounded
    // by totalTimeoutMs and always cleared in finally.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.totalTimeoutMs);
    try {
      return await this.perform(input, controller.signal, () => timedOut);
    } catch (error) {
      if (error instanceof BrowserDirectHttpError) throw error;
      if (error instanceof BrowserRequestPolicyError) {
        throw new BrowserDirectHttpError(error.code, error.message);
      }
      if (controller.signal.aborted) throw abortError(timedOut);
      throw new BrowserDirectHttpError('transport_error', 'Direct HTTP transport failed');
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
      this.active -= 1;
    }
  }

  private async perform(
    input: BrowserDirectHttpRequest,
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<BrowserDirectHttpResult> {
    let url = input.url;
    let method = input.method;
    let body = input.body;
    const visited = new Set<string>();
    const redirects: BrowserDirectHttpResult['redirects'] = [];
    for (let hop = 0; ; hop += 1) {
      if (signal.aborted) throw abortError(timedOut());
      const authorized = input.destinationPolicy === 'provider'
        ? authorizeProviderRequest({
            url,
            method,
            headers: input.headers,
            ...(body !== undefined ? { body } : {}),
            limits: { maxRequestBytes: this.limits.maxRequestBytes },
          })
        : authorizeBrowserRequest({
            url,
            authorizedDomain: input.authorizedDomain ?? siteBoundaryForUrl(url),
            method,
            headers: input.headers,
            ...(body !== undefined ? { body } : {}),
            limits: { maxRequestBytes: this.limits.maxRequestBytes },
          });
      const canonical = authorized.url.toString();
      if (visited.has(canonical)) throw new BrowserDirectHttpError('redirect_loop', 'Redirect loop detected');
      visited.add(canonical);
      const destination = await promiseWithAbort(
        input.destinationPolicy === 'provider'
          ? resolveProviderDestination(authorized, this.resolver)
          : resolveSafeDestination(authorized, this.resolver),
        signal,
        timedOut,
      );
      const hookHeaders = input.prepareHopHeaders
        ? validateHookHeaders(await promiseWithAbort(
          Promise.resolve(input.prepareHopHeaders(authorized, destination)),
          signal,
          timedOut,
        ))
        : {};
      const headers = {
        ...authorized.headers,
        ...hookHeaders,
        'accept-encoding': 'identity',
        ...(authorized.body ? { 'content-length': String(authorized.body.byteLength) } : {}),
      };
      const transportResponse = await promiseWithAbort(this.transport.request({
        protocol: authorized.url.protocol as 'http:' | 'https:',
        hostname: destination.hostname,
        servername: destination.hostname,
        pinnedAddress: destination.address,
        family: destination.family,
        port: destination.port,
        path: `${authorized.url.pathname}${authorized.url.search}`,
        method: authorized.method,
        headers,
        ...(authorized.body ? { body: authorized.body } : {}),
        signal,
        connectTimeoutMs: this.limits.connectTimeoutMs,
        headerTimeoutMs: this.limits.headerTimeoutMs,
        inactivityTimeoutMs: this.limits.inactivityTimeoutMs,
      }), signal, timedOut);
      const responseHeaderMap = responseHeaders(transportResponse.headers);
      const status = transportResponse.statusCode;
      const location = responseHeaderMap.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        transportResponse.close();
        if (input.redirectPolicy === 'error') {
          throw new BrowserDirectHttpError('redirect_not_allowed', 'Redirects are not allowed for this request');
        }
        if (hop >= this.limits.maxRedirects) {
          throw new BrowserDirectHttpError('redirect_limit_exceeded', 'Redirect limit exceeded');
        }
        let next: URL;
        try {
          next = new URL(location, authorized.url);
        } catch {
          throw new BrowserDirectHttpError('invalid_redirect', 'Redirect location is malformed');
        }
        const transitioned = redirectMethod(status, authorized.method, authorized.body);
        redirects.push({ status, from: canonical, to: next.toString(), method: transitioned.method });
        url = next.toString();
        method = transitioned.method;
        body = transitioned.body;
        continue;
      }
      const wire = await readWireBody(
        transportResponse,
        signal,
        timedOut,
        this.limits.maxResponseWireBytes,
      );
      const decoded = decodeBody(wire, responseHeaderMap['content-encoding'], this.limits);
      return {
        url: canonical,
        method: authorized.method,
        status,
        headers: responseHeaderMap,
        body: decoded,
        redirects,
      };
    }
  }
}
