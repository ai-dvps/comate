import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Sandbox-aware HTTP transport (U12, V10 finding).
 *
 * Inside the SDK execution sandbox, direct outbound connections are blocked
 * at the OS layer; all egress must go through the sandbox's own HTTP proxy
 * (injected as `http_proxy`/`HTTP_PROXY` with per-session credentials). The
 * proxy relays to allowlisted hosts — the bot derivation allowlists the
 * sidecar loopback (`127.0.0.1`, `localhost`), so routing our loopback API
 * calls through the proxy is the ONLY way they leave the sandbox. The
 * sandbox also injects `NO_PROXY=localhost,127.0.0.1,…`, which makes
 * proxy-honoring clients bypass the proxy for loopback and fail — we must
 * NOT honor NO_PROXY for our own loopback API calls: the proxy is the
 * sanctioned egress, not a detour.
 *
 * Outside a sandbox there is no proxy env and requests go direct.
 */

interface ProxyConfig {
  hostname: string;
  port: number;
  authHeader: string | null;
}

function resolveProxy(target: URL): ProxyConfig | null {
  // Only plain-http targets use the HTTP proxy form; https targets would
  // need CONNECT tunneling, which this CLI does not currently need.
  if (target.protocol !== 'http:') return null;
  const raw = process.env.http_proxy ?? process.env.HTTP_PROXY;
  if (!raw) return null;
  let proxy: URL;
  try {
    proxy = new URL(raw);
  } catch {
    return null;
  }
  let authHeader: string | null = null;
  if (proxy.username) {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password ?? '');
    authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return {
    hostname: proxy.hostname,
    port: Number(proxy.port) || 80,
    authHeader,
  };
}

interface Transport {
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
}

function transportFor(url: string, baseHeaders: Record<string, string>): Transport & { client: typeof http | typeof https } {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const proxy = resolveProxy(parsed);
  if (proxy) {
    // Absolute-URI request form + Proxy-Authorization (textbook HTTP/1.1
    // forward-proxy request; the Host header still names the target).
    return {
      client: http,
      hostname: proxy.hostname,
      port: proxy.port,
      path: parsed.href,
      headers: {
        Host: parsed.host,
        ...(proxy.authHeader ? { 'Proxy-Authorization': proxy.authHeader } : {}),
        ...baseHeaders,
      },
    };
  }
  return {
    client,
    hostname: parsed.hostname,
    port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      Host: parsed.host,
      ...baseHeaders,
    },
  };
}

export function getJson(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = transportFor(url, {
      Accept: 'application/json',
      ...headers,
    });
    const req = transport.client.request(
      {
        hostname: transport.hostname,
        port: transport.port,
        path: transport.path,
        method: 'GET',
        headers: transport.headers,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      }
    );
    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
}

export function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyString = JSON.stringify(body);
    const transport = transportFor(url, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyString)),
      ...headers,
    });
    const req = transport.client.request(
      {
        hostname: transport.hostname,
        port: transport.port,
        path: transport.path,
        method: 'POST',
        headers: transport.headers,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: responseBody });
        });
      }
    );
    req.on('error', (err) => {
      reject(err);
    });
    req.write(bodyString);
    req.end();
  });
}

export function postForBinary(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const bodyString = JSON.stringify(body);
    const transport = transportFor(url, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyString)),
      ...headers,
    });
    const req = transport.client.request(
      {
        hostname: transport.hostname,
        port: transport.port,
        path: transport.path,
        method: 'POST',
        headers: transport.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || '',
          });
        });
      }
    );
    req.on('error', (err) => {
      reject(err);
    });
    req.write(bodyString);
    req.end();
  });
}
