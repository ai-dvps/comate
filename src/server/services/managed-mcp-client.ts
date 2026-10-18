import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ManagedMcpRecord } from '@comate/api-contracts';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

/** Redirects never forward credentials to a different origin. */
export const managedMcpFetch: typeof fetch = async (input, init) => {
  let request = new Request(input, { ...init, redirect: 'manual' });
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (!['http:', 'https:'].includes(new URL(request.url).protocol)) throw new Error('Unsupported MCP URL scheme');
    const replay = request.clone();
    const response = await fetch(request);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) return response;
    const target = new URL(response.headers.get('location')!, request.url);
    if (target.origin !== new URL(request.url).origin) {
      await response.body?.cancel();
      throw new Error('Cross-origin MCP redirect refused');
    }
    const method = response.status === 303 || ([301, 302].includes(response.status) && request.method === 'POST') ? 'GET' : request.method;
    await response.body?.cancel();
    request = new Request(target, { method, headers: request.headers, redirect: 'manual', signal: request.signal,
      ...(method !== 'GET' && method !== 'HEAD' ? { body: await replay.arrayBuffer() } : {}) });
  }
  throw new Error('Too many MCP redirects');
};

export function managedMcpError(error: unknown): string {
  const code = (error as { code?: unknown; name?: string })?.code;
  const message = error instanceof Error ? error.message : '';
  if (['Program not found. Check the MCP command and PATH.', 'Authorization required. Sign in or update the service credentials.',
    'MCP operation was cancelled.'].includes(message)) return message;
  if (code === 'ENOENT') return 'Program not found. Check the MCP command and PATH.';
  if (error instanceof UnauthorizedError || code === 401 || message === 'Authorization required' || message === 'MCP authorization expired. Sign in again.') return 'Authorization required. Sign in or update the service credentials.';
  if ((error as { name?: string })?.name === 'AbortError') return 'MCP operation was cancelled.';
  return 'MCP connection failed. Check the program, address, network and authentication.';
}

export interface ManagedMcpClient {
  client: Client;
  close(): Promise<void>;
}

export function sanitizeMcpValue<T>(record: ManagedMcpRecord, value: T): T {
  const connection = record.connection;
  const secrets = [
    ...Object.values(connection?.type === 'stdio' ? connection.env ?? {} : connection?.headers ?? {}),
    ...(connection?.type === 'stdio' ? connection.args ?? [] : []),
    record.oauthState?.tokens?.access_token, record.oauthState?.tokens?.refresh_token, record.oauthState?.tokens?.id_token,
    record.oauthState?.clientInformation?.client_secret,
    connection && connection.type !== 'stdio' ? connection.oauth?.clientSecret : undefined,
  ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  if (connection && connection.type !== 'stdio') {
    const url = new URL(connection.url);
    secrets.push(...[url.username, url.password, ...url.searchParams.values()].filter(Boolean));
  }
  for (const secret of [...secrets]) if (/^(Bearer|Basic) /i.test(secret)) secrets.push(secret.slice(secret.indexOf(' ') + 1));
  for (const secret of [...secrets]) if (encodeURIComponent(secret) !== secret) secrets.push(encodeURIComponent(secret));
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, walk(value)]));
    return item;
  };
  return walk(value) as T;
}

export async function connectManagedMcp(
  record: ManagedMcpRecord,
  directory: string,
  authProvider?: OAuthClientProvider,
): Promise<ManagedMcpClient> {
  const connection = record.connection;
  if (!connection) throw new Error(record.error ?? 'MCP connection settings are missing');
  const client = new Client({ name: 'comate-managed-mcp', version: '1.0.0' }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(directory).href, name: 'Workspace' }] }));
  const basicEnv: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'USERPROFILE', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) basicEnv[key] = process.env[key]!;
  }
  const transport = connection.type === 'stdio'
    ? new StdioClientTransport({ command: connection.command, args: connection.args,
      env: { ...basicEnv, ...connection.env }, cwd: directory, stderr: 'pipe' })
    : connection.type === 'sse'
      ? new SSEClientTransport(new URL(connection.url), { authProvider,
        requestInit: { headers: connection.headers }, fetch: managedMcpFetch,
        eventSourceInit: { fetch: (input, init) => {
          const headers = new Headers(connection.headers);
          new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
          return managedMcpFetch(input, { ...init, headers });
        } } })
      : new StreamableHTTPClientTransport(new URL(connection.url), { authProvider,
        requestInit: { headers: connection.headers }, fetch: managedMcpFetch,
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  // Do not pipe a user command's stderr into application or chat logs.
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => undefined);
  try {
    await client.connect(transport, { timeout: 15_000 });
    return { client, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(managedMcpError(error));
  }
}
