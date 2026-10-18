import { createHash } from 'node:crypto';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed, OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { ManagedMcpRecord, McpOAuthState } from '@comate/api-contracts';
import type { McpOAuthService } from './mcp-oauth-service.js';
import { McpConfigError } from '../storage/mcp-config-store.js';

export function mcpOAuthIdentity(record: ManagedMcpRecord): string {
  return createHash('sha256').update(JSON.stringify([record.id, record.scope, record.connection])).digest('hex');
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly identity: string;
  private verifier?: string;
  private issuerRequirement?: { issuer: string; required: boolean };
  authorizationUrl?: string;
  constructor(readonly service: McpOAuthService, readonly record: ManagedMcpRecord,
    readonly redirectUrl = 'http://127.0.0.1/oauth/callback', private readonly nonce?: string, private readonly active?: () => boolean) {
    this.identity = mcpOAuthIdentity(record);
  }

  current(): ManagedMcpRecord {
    if (this.active && !this.active()) throw new Error('Authorization expired');
    const current = this.service.config.store.mcp.get(this.record.id);
    if (!current || current.revision !== this.record.revision || mcpOAuthIdentity(current) !== this.identity ||
        current.oauthState?.credentialGeneration !== this.record.oauthState?.credentialGeneration) {
      throw new McpConfigError('MCP authorization is stale', 409);
    }
    return current;
  }
  private stateData(): McpOAuthState {
    return this.current().oauthState ?? { identity: this.identity };
  }
  private save(update: Partial<McpOAuthState>): void {
    this.service.config.store.mcp.saveOAuth(this.record.id, this.record.revision, { ...this.stateData(), ...update, identity: this.identity });
  }
  get options() { const connection = this.record.connection; return connection?.type !== 'stdio' ? connection?.oauth : undefined; }
  get clientMetadataUrl() { return this.options?.clientMetadataUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Comate', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: this.options?.clientSecret ? 'client_secret_basic' : 'none',
      scope: this.options?.scopes?.join(' ') };
  }
  state() { if (!this.nonce) throw new Error('Authorization required'); return this.nonce; }
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.options?.clientId) return { client_id: this.options.clientId, client_secret: this.options.clientSecret };
    return this.stateData().clientInformation as OAuthClientInformationMixed | undefined;
  }
  saveClientInformation(info: OAuthClientInformationMixed) { this.save({ clientInformation: info }); }
  async tokens(): Promise<OAuthTokens | undefined> {
    // Only the host refreshes tokens, under one lock shared by every workspace
    // inheriting this entry. Do not let each transport refresh independently.
    const tokens = await this.service.tokens(this);
    return tokens ? { ...tokens, refresh_token: undefined } : undefined;
  }
  saveTokens(tokens: OAuthTokens) { this.save({ tokens, obtainedAt: this.service.now(), reauthorizationRequired: false }); }
  redirectToAuthorization(url: URL) {
    if (!this.nonce) { this.invalidateCredentials('tokens'); throw new Error('Authorization required'); }
    this.authorizationUrl = url.href;
  }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error('Authorization expired'); return this.verifier; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.stateData().discovery as OAuthDiscoveryState | undefined; }
  observeDiscoveryMetadata(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const metadata = value as Record<string, unknown>;
    if (typeof metadata.issuer === 'string' && typeof metadata.authorization_endpoint === 'string' &&
        typeof metadata.authorization_response_iss_parameter_supported === 'boolean') {
      this.issuerRequirement = { issuer: metadata.issuer, required: metadata.authorization_response_iss_parameter_supported };
    }
  }
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    const requested = resourceUrlFromServerUrl(serverUrl);
    if (resource && !checkResourceAllowed({ requestedResource: requested, configuredResource: resource })) throw new Error('MCP OAuth resource mismatch');
    return new URL(resource ?? requested.href);
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata || metadata.issuer !== discovery.authorizationServerUrl) throw new Error('OAuth issuer metadata mismatch');
    // The pinned SDK's OIDC schema strips this RFC 9207 extension.
    if (this.issuerRequirement?.issuer === metadata.issuer) discovery = { ...discovery,
      authorizationServerMetadata: { ...metadata, authorization_response_iss_parameter_supported: this.issuerRequirement.required },
    };
    for (const value of [discovery.authorizationServerUrl, metadata?.authorization_endpoint, metadata?.token_endpoint, metadata?.registration_endpoint]) {
      if (!value) continue;
      const url = new URL(value);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('OAuth endpoints require HTTPS');
      }
    }
    this.save({ discovery: discovery as unknown as Record<string, unknown> });
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'verifier') { this.verifier = undefined; return; }
    if (scope === 'all') this.save({ tokens: undefined, obtainedAt: undefined, clientInformation: undefined, discovery: undefined });
    else if (scope === 'tokens') this.save({ tokens: undefined, obtainedAt: undefined,
      reauthorizationRequired: Boolean(this.stateData().tokens || this.stateData().reauthorizationRequired) });
    else if (scope === 'client') this.save({ clientInformation: undefined });
    else this.save({ discovery: undefined });
  }
}
