import { z } from 'zod';

export const mcpScopeSchema = z.string().regex(/^(global|workspace:[A-Za-z0-9_-]+)$/);
export const mcpNameSchema = z.string().min(1).max(128).refine(value =>
  value === value.trim() && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const values = z.record(z.string().min(1), z.string());
const url = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol));
export const mcpOAuthOptionsSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  clientMetadataUrl: url.optional(),
  scopes: z.array(z.string().min(1)).optional(),
}).strict();
export const mcpConnectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: values.optional() }).strict(),
  z.object({ type: z.literal('http'), url, headers: values.optional(), oauth: mcpOAuthOptionsSchema.optional() }).strict(),
  z.object({ type: z.literal('sse'), url, headers: values.optional(), oauth: mcpOAuthOptionsSchema.optional() }).strict(),
]);
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
export type McpScope = string;
export interface McpOAuthState {
  identity: string;
  credentialGeneration?: string;
  reauthorizationRequired?: boolean;
  tokens?: { access_token: string; token_type: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string };
  obtainedAt?: number;
  clientInformation?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
}
export interface ManagedMcpRecord {
  id: string;
  scope: McpScope;
  name: string;
  kind: 'server' | 'disabled';
  enabled: boolean;
  revision: number;
  connection?: McpConnection;
  oauthState?: McpOAuthState;
  error?: string;
}
export interface McpServerView {
  id: string;
  scope: McpScope;
  name: string;
  kind: 'server' | 'disabled';
  enabled: boolean;
  revision: number;
  type?: McpConnection['type'];
  command?: string;
  url?: string;
  argCount: number;
  envKeys: string[];
  headerKeys: string[];
  oauth: boolean;
  authorization: 'not_required' | 'not_authorized' | 'authorized' | 'reauthorization_required';
  inherited?: boolean;
  overridden?: boolean;
  error?: string;
}
export interface McpConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'failed' | 'authorization_required';
  error?: string;
  tools?: Array<{ name: string; description?: string }>;
}
export interface McpSessionApplication {
  sessionId: string;
  workspaceId: string;
  entryId?: string;
  name: string;
  backend: string;
  desired: number;
  applied: number;
  state: 'applied' | 'pending' | 'applying' | 'failed';
  error?: string;
}
