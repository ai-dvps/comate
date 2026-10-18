import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { mcpConnectionSchema, mcpNameSchema, mcpScopeSchema,
  type ManagedMcpRecord, type McpServerView } from '@comate/api-contracts';
import { store, type SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigError } from '../storage/mcp-config-store.js';

const writeSchema = z.object({
  id: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  scope: mcpScopeSchema, name: mcpNameSchema, enabled: z.boolean(),
  kind: z.enum(['server', 'disabled']).optional(), connection: mcpConnectionSchema.optional(),
}).strict();

export class McpConfigService extends EventEmitter {
  constructor(readonly store: SqliteStore) { super(); }

  async validateScope(scope: string): Promise<void> {
    if (!mcpScopeSchema.safeParse(scope).success) throw new McpConfigError('Invalid MCP scope');
    if (scope !== 'global') {
      const workspace = await this.store.get(scope.slice('workspace:'.length));
      if (!workspace) throw new McpConfigError('Workspace not found', 404);
      this.store.mcp.migrateWorkspace(workspace.id, workspace.mcpServers);
    }
  }

  async records(workspaceId: string, includeDisabled = false): Promise<ManagedMcpRecord[]> {
    const scope = `workspace:${workspaceId}`;
    await this.validateScope(scope);
    const merged = new Map(this.store.mcp.list('global').map(record => [record.name, record]));
    for (const record of this.store.mcp.list(scope)) merged.set(record.name, record);
    return [...merged.values()].filter(record => includeDisabled || (record.kind === 'server' && record.enabled && record.connection));
  }

  effective(workspaceId: string): Promise<ManagedMcpRecord[]> { return this.records(workspaceId); }

  async list(scope: string): Promise<McpServerView[]> {
    await this.validateScope(scope);
    const own = this.store.mcp.list(scope);
    if (scope === 'global') return own.map(record => this.view(record));
    const names = new Set(own.map(record => record.name));
    return [...own.map(record => this.view(record)), ...this.store.mcp.list('global').map(record => ({
      ...this.view(record), inherited: true, overridden: names.has(record.name),
    }))];
  }

  view(record: ManagedMcpRecord): McpServerView {
    const connection = record.connection;
    let safeUrl: string | undefined;
    if (connection && connection.type !== 'stdio') {
      const url = new URL(connection.url);
      safeUrl = `${url.origin}${url.pathname}`;
    }
    const oauth = Boolean(connection && connection.type !== 'stdio' && connection.oauth);
    const state = record.oauthState;
    const expired = state?.tokens?.expires_in !== undefined &&
      (state.obtainedAt ?? 0) + state.tokens.expires_in * 1000 <= Date.now();
    return {
      id: record.id, scope: record.scope, name: record.name, kind: record.kind,
      enabled: record.enabled, revision: record.revision, type: connection?.type,
      error: record.error,
      command: connection?.type === 'stdio' ? connection.command : undefined,
      url: safeUrl, argCount: connection?.type === 'stdio' ? connection.args?.length ?? 0 : 0,
      envKeys: connection?.type === 'stdio' ? Object.keys(connection.env ?? {}) : [],
      headerKeys: connection && connection.type !== 'stdio' ? Object.keys(connection.headers ?? {}) : [],
      oauth, authorization: !oauth ? 'not_required' : state?.reauthorizationRequired ? 'reauthorization_required' : !state?.tokens ? 'not_authorized'
        : expired && !state.tokens.refresh_token ? 'reauthorization_required' : 'authorized',
    };
  }

  async save(input: unknown): Promise<McpServerView> {
    const parsed = writeSchema.safeParse(input);
    if (!parsed.success) throw new McpConfigError(this.validationMessage(parsed.error));
    await this.validateScope(parsed.data.scope);
    if (parsed.data.kind === 'disabled' && parsed.data.scope === 'global') {
      throw new McpConfigError('An inheritance exclusion belongs to a workspace');
    }
    const record = this.store.mcp.save(parsed.data);
    this.emit('change', { scope: record.scope, id: record.id });
    return this.view(record);
  }

  async import(scope: string, input: unknown): Promise<McpServerView[]> {
    await this.validateScope(scope);
    let value: unknown;
    try { value = typeof input === 'string' ? JSON.parse(input) : input; }
    catch { throw new McpConfigError('Invalid JSON'); }
    if (typeof input === 'string') {
      const containers: Array<Set<string> | null> = [];
      for (const token of input.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
        if (token[0] === '{') containers.push(new Set());
        else if (token[0] === '[') containers.push(null);
        else if (token[0] === '}' || token[0] === ']') containers.pop();
        else if (/^\s*:/.test(input.slice(token.index! + token[0].length))) {
          const keys = containers.at(-1);
          const key = JSON.parse(token[0]) as string;
          if (keys?.has(key)) throw new McpConfigError(`Invalid JSON: duplicate key at character ${token.index}`);
          keys?.add(key);
        }
      }
    }
    const root = z.object({ mcpServers: z.record(mcpNameSchema, z.unknown()) }).strict().safeParse(value);
    if (!root.success) throw new McpConfigError(this.validationMessage(root.error));
    const entries = Object.entries(root.data.mcpServers).map(([name, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpConfigError(`mcpServers.${name}: invalid connection`);
      const object = raw as Record<string, unknown>;
      const connection = mcpConnectionSchema.safeParse({ ...object, type: object.type ?? (object.command ? 'stdio' : 'http') });
      if (!connection.success) throw new McpConfigError(`mcpServers.${name}: ${this.validationMessage(connection.error)}`);
      return { name, enabled: true, connection: connection.data };
    });
    const records = this.store.mcp.import(scope, entries);
    this.emit('change', { scope });
    return records.map(record => this.view(record));
  }

  async delete(id: string, revision: number): Promise<void> {
    const old = this.store.mcp.get(id);
    if (!old) throw new McpConfigError('MCP service not found', 404);
    await this.validateScope(old.scope);
    this.store.mcp.delete(id, revision);
    this.emit('change', { scope: old.scope, id });
  }

  private validationMessage(error: z.ZodError): string {
    return error.issues.map(issue => `${issue.path.join('.') || 'configuration'}: ${issue.code}`).join('; ');
  }
}

export const mcpConfigService = new McpConfigService(store);
