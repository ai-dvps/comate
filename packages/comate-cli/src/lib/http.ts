import http from 'node:http';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10 * 60_000;

interface ProxyConfig {
  hostname: string;
  port: number;
  authorization?: string;
}

function proxyFromEnv(env: NodeJS.ProcessEnv): ProxyConfig | null {
  // Deliberately ignore NO_PROXY: the SDK sandbox requires loopback requests
  // to traverse its authenticated forward proxy.
  const raw = env.http_proxy || env.HTTP_PROXY;
  if (!raw) return null;
  try {
    const proxy = new URL(raw);
    if (proxy.protocol !== 'http:') return null;
    const authorization = proxy.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
      : undefined;
    return {
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      ...(authorization ? { authorization } : {}),
    };
  } catch {
    return null;
  }
}

export async function postJson(
  url: string,
  body: unknown,
  token: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  const proxy = proxyFromEnv(options.env ?? process.env);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const request = http.request({
      hostname: proxy?.hostname ?? target.hostname,
      port: proxy?.port ?? Number(target.port || 80),
      path: proxy ? target.href : `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        Host: target.host,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        Authorization: `Bearer ${token}`,
        ...(proxy?.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}),
      },
      signal: options.signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Comate returned an oversized response.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', (error) => finish(reject, error));
      response.once('aborted', () => finish(reject, new Error('Comate response ended before completion.')));
      response.on('end', () => finish(resolve, {
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', (error) => finish(reject, error));
    const deadline = setTimeout(() => {
      request.destroy(new Error('Timed out waiting for Comate approval or response.'));
    }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    request.end(payload);
  });
}
