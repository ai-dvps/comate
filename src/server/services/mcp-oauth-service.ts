import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { auth, refreshAuthorization, selectResourceURL, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ManagedMcpRecord } from '@comate/api-contracts';
import { McpConfigError } from '../storage/mcp-config-store.js';
import { mcpConfigService, type McpConfigService } from './mcp-config-service.js';
import { McpOAuthProvider, mcpOAuthIdentity } from './mcp-oauth-provider.js';

// OAuth bodies contain secrets. Refuse redirects rather than replaying those
// bodies or credentials at another endpoint. Discovery itself remains standard.
const oauthFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(15_000) });
interface Authorization {
  id: string; entryId: string; state: 'waiting' | 'authorized' | 'cancelled' | 'expired' | 'failed';
  authorizationUrl?: string; error?: string; listener: Server; timer: NodeJS.Timeout;
}

export class McpOAuthService {
  private operations = new Map<string, Authorization>();
  private refreshes = new Map<string, Promise<OAuthTokens | undefined>>();
  constructor(readonly config: McpConfigService, readonly now = Date.now) {
    config.on('change', this.onChange);
  }
  private onChange = ({ id }: { id?: string }) => {
    for (const operation of this.operations.values()) {
      if (operation.state === 'waiting' && (!id || operation.entryId === id)) this.finish(operation, 'cancelled');
    }
  };
  provider(record: ManagedMcpRecord): McpOAuthProvider { return new McpOAuthProvider(this, record); }
  private discoveryFetch(provider: McpOAuthProvider): typeof fetch {
    return async (input, init) => {
      const response = await oauthFetch(input, init);
      if ((!init?.method || init.method === 'GET') && response.headers.get('content-type')?.includes('application/json')) {
        provider.observeDiscoveryMetadata(await response.clone().json().catch(() => undefined));
      }
      return response;
    };
  }
  status(id: string) {
    const operation = this.operations.get(id);
    if (!operation) throw new McpConfigError('Authorization not found', 404);
    return { id: operation.id, entryId: operation.entryId, state: operation.state,
      authorizationUrl: operation.state === 'waiting' ? operation.authorizationUrl : undefined, error: operation.error };
  }
  cancel(id: string): void {
    const operation = this.operations.get(id);
    if (!operation) throw new McpConfigError('Authorization not found', 404);
    if (operation.state === 'waiting') this.finish(operation, 'cancelled');
  }
  private finish(operation: Authorization, state: Authorization['state'], error?: string): void {
    operation.state = state; operation.error = error;
    clearTimeout(operation.timer);
    operation.listener.close();
    operation.listener.closeIdleConnections();
    if (state === 'authorized') this.config.emit('change', { id: operation.entryId, authorization: true });
  }
  async start(entryId: string) {
    let record = this.config.store.mcp.get(entryId);
    const connection = record?.connection;
    if (!record || !connection || connection.type === 'stdio' || !connection.oauth) throw new McpConfigError('This MCP service does not use OAuth');
    for (const operation of this.operations.values()) if (operation.entryId === entryId && operation.state === 'waiting') this.finish(operation, 'cancelled');
    this.config.store.mcp.saveOAuth(entryId, record.revision, { ...record.oauthState, tokens: undefined, obtainedAt: undefined,
      identity: mcpOAuthIdentity(record), credentialGeneration: randomUUID(),
      reauthorizationRequired: Boolean(record.oauthState?.tokens || record.oauthState?.reauthorizationRequired) });
    record = this.config.store.mcp.get(entryId)!;
    // Discard old terminal operations; status polling only needs recent history.
    if (this.operations.size > 100) for (const [id, operation] of this.operations) if (operation.state !== 'waiting') this.operations.delete(id);
    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    let consumed = false;
    const listener = createServer((req, res) => {
      const callback = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const state = callback.searchParams.get('state') ?? '';
      if (req.method !== 'GET' || callback.pathname !== '/oauth/callback' || consumed || Buffer.byteLength(state) !== Buffer.byteLength(nonce) || !timingSafeEqual(Buffer.from(state), Buffer.from(nonce))) {
        res.writeHead(400).end('Invalid or expired authorization callback.'); return;
      }
      consumed = true;
      void (async () => {
        const operation = this.operations.get(id)!;
        try {
          provider.current();
          const issuer = callback.searchParams.get('iss');
          const discovery = provider.discoveryState();
          const issuerRequired = (discovery?.authorizationServerMetadata as Record<string, unknown> | undefined)?.authorization_response_iss_parameter_supported;
          if ((issuerRequired && !issuer) || (issuer && issuer !== discovery?.authorizationServerMetadata?.issuer)) throw new Error('Issuer mismatch');
          if (callback.searchParams.has('error') || !callback.searchParams.get('code')) throw new Error('Authorization declined');
          if (operation.state !== 'waiting') throw new Error('Authorization expired');
          await auth(provider, { serverUrl: connection.url, authorizationCode: callback.searchParams.get('code')!, fetchFn: this.discoveryFetch(provider) });
          res.writeHead(200).end('MCP authorization complete. You can close this window and return to Comate.');
          this.finish(operation, 'authorized');
        } catch {
          res.writeHead(400).end('MCP authorization failed. Return to Comate and try again.');
          this.finish(operation, 'failed', 'Authorization failed or expired. Sign in again.');
        }
      })();
    });
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const redirect = `http://127.0.0.1:${(listener.address() as { port: number }).port}/oauth/callback`;
    const provider = new McpOAuthProvider(this, record, redirect, nonce, () => this.operations.get(id)?.state === 'waiting');
    const operation: Authorization = { id, entryId, state: 'waiting', listener,
      timer: setTimeout(() => this.finish(operation, 'expired'), 10 * 60_000) };
    operation.timer.unref();
    this.operations.set(id, operation);
    try {
      provider.invalidateCredentials('tokens');
      const challenge = await oauthFetch(connection.url, { headers: connection.headers });
      const hints = extractWWWAuthenticateParams(challenge);
      await challenge.body?.cancel();
      await auth(provider, { serverUrl: connection.url, scope: hints.scope ?? connection.oauth.scopes?.join(' '),
        resourceMetadataUrl: hints.resourceMetadataUrl, fetchFn: this.discoveryFetch(provider) });
      operation.authorizationUrl = provider.authorizationUrl;
      if (!operation.authorizationUrl) throw new Error('No authorization URL');
      return this.status(id);
    } catch {
      this.finish(operation, 'failed', 'Unable to start OAuth. Check server discovery and client registration settings.');
      throw new McpConfigError(operation.error!, 400);
    }
  }
  async tokens(provider: McpOAuthProvider): Promise<OAuthTokens | undefined> {
    const record = provider.current();
    const state = record.oauthState;
    const tokens = state?.tokens;
    if (!tokens) return undefined;
    if (tokens.expires_in === undefined || (state.obtainedAt ?? 0) + tokens.expires_in * 1000 > this.now() + 1000) return tokens;
    const key = `${provider.identity}:${record.oauthState?.credentialGeneration ?? 'legacy'}`;
    const pending = this.refreshes.get(key);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const discovery = provider.discoveryState();
        const clientInformation = provider.clientInformation();
        const connection = record.connection;
        if (!tokens.refresh_token || !discovery || !clientInformation || !connection || connection.type === 'stdio') throw new Error('Sign in again');
        const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
          metadata: discovery.authorizationServerMetadata, clientInformation, refreshToken: tokens.refresh_token,
          resource: await selectResourceURL(connection.url, provider, discovery.resourceMetadata), fetchFn: oauthFetch,
        });
        provider.saveTokens(refreshed);
        return refreshed;
      } catch {
        try { provider.invalidateCredentials('tokens'); } catch { /* A replaced entry owns a different authorization. */ }
        throw new Error('MCP authorization expired. Sign in again.');
      } finally { this.refreshes.delete(key); }
    })();
    this.refreshes.set(key, refresh);
    return refresh;
  }
  dispose(): void {
    this.config.off('change', this.onChange);
    for (const operation of this.operations.values()) if (operation.state === 'waiting') this.finish(operation, 'cancelled');
    this.operations.clear();
  }
}

export const mcpOAuthService = new McpOAuthService(mcpConfigService);
