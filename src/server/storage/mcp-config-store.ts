import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ManagedMcpRecord, McpConnection, McpOAuthState } from '@comate/api-contracts';
import { encryptCredential, decryptCredential } from '../utils/credential-crypto.js';

export class McpConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface McpRecordWrite {
  id?: string;
  scope: string;
  name: string;
  kind?: 'server' | 'disabled';
  enabled: boolean;
  connection?: McpConnection;
  expectedRevision?: number;
}
interface Row {
  id: string; scope: string; name: string; kind: 'server' | 'disabled';
  enabled: number; revision: number; payload: string;
}

/** All operations use SqliteStore's existing connection and transactions. */
export class McpConfigStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_entries (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
      payload TEXT NOT NULL, UNIQUE(scope, name)
    ); CREATE TABLE IF NOT EXISTS mcp_scope_revisions (
      scope TEXT PRIMARY KEY, revision INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS mcp_workspace_migrations (workspace_id TEXT PRIMARY KEY);`);
  }

  private decode(row: Row): ManagedMcpRecord {
    try {
      const payload = JSON.parse(decryptCredential(row.payload));
      return { id: row.id, scope: row.scope, name: row.name, kind: row.kind,
        enabled: Boolean(row.enabled), revision: row.revision, ...payload };
    } catch {
      throw new McpConfigError('MCP credentials cannot be decrypted. Reconfigure this service.', 500);
    }
  }

  list(scope: string): ManagedMcpRecord[] {
    return (this.db.prepare('SELECT * FROM mcp_entries WHERE scope = ? ORDER BY name').all(scope) as Row[]).map(row => this.decode(row));
  }

  get(id: string): ManagedMcpRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_entries WHERE id = ?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  revision(scope: string): number {
    return (this.db.prepare('SELECT revision FROM mcp_scope_revisions WHERE scope = ?').get(scope) as { revision: number } | undefined)?.revision ?? 0;
  }

  private bump(scope: string): void {
    this.db.prepare('INSERT INTO mcp_scope_revisions VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET revision = revision + 1').run(scope);
  }

  save(input: McpRecordWrite): ManagedMcpRecord {
    return this.db.transaction(() => {
      const old = input.id ? this.get(input.id) : undefined;
      if (input.id && (!old || old.scope !== input.scope)) throw new McpConfigError('MCP service not found', 404);
      if (old && old.revision !== input.expectedRevision) throw new McpConfigError('MCP revision conflict. Reload before saving.', 409);
      const duplicate = this.db.prepare('SELECT id FROM mcp_entries WHERE scope = ? AND name = ?').get(input.scope, input.name) as { id: string } | undefined;
      if (duplicate && duplicate.id !== old?.id) throw new McpConfigError('MCP service already exists in this scope', 409);
      const kind = input.kind ?? 'server';
      const connection = kind === 'disabled' ? undefined : input.connection ?? old?.connection;
      if (kind === 'server' && !connection) throw new McpConfigError('Connection is required');
      const unchanged = JSON.stringify(connection) === JSON.stringify(old?.connection);
      const payload = encryptCredential(JSON.stringify({ connection, ...(unchanged && old?.oauthState ? { oauthState: old.oauthState } : {}) }));
      const record = { id: old?.id ?? randomUUID(), scope: input.scope, name: input.name, kind,
        enabled: kind === 'server' && input.enabled, revision: (old?.revision ?? 0) + 1 };
      this.db.prepare(`INSERT INTO mcp_entries VALUES (@id, @scope, @name, @kind, @enabled, @revision, @payload)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, enabled=excluded.enabled,
        revision=excluded.revision, payload=excluded.payload`).run({ ...record, enabled: Number(record.enabled), payload });
      this.bump(input.scope);
      return this.get(record.id)!;
    })();
  }

  import(scope: string, inputs: Omit<McpRecordWrite, 'scope'>[]): ManagedMcpRecord[] {
    return this.db.transaction(() => inputs.map(input => this.save({ ...input, scope })))();
  }

  saveOAuth(id: string, revision: number, oauthState: McpOAuthState): void {
    this.db.transaction(() => {
      const old = this.get(id);
      if (!old || old.revision !== revision) throw new McpConfigError('MCP authorization is stale', 409);
      this.db.prepare('UPDATE mcp_entries SET payload = ? WHERE id = ?').run(
        encryptCredential(JSON.stringify({ connection: old.connection, oauthState })), id,
      );
    })();
  }

  delete(id: string, expectedRevision: number): void {
    this.db.transaction(() => {
      const old = this.get(id);
      if (!old) throw new McpConfigError('MCP service not found', 404);
      if (old.revision !== expectedRevision) throw new McpConfigError('MCP revision conflict', 409);
      this.db.prepare('DELETE FROM mcp_entries WHERE id = ?').run(id);
      this.bump(old.scope);
    })();
  }

  deleteScope(scope: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM mcp_entries WHERE scope = ?').run(scope);
      this.bump(scope);
    })();
  }

  migrateWorkspace(id: string, entries: Array<{ name: string; command: string; args?: string[] }>): void {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM mcp_workspace_migrations WHERE workspace_id = ?').get(id)) return;
      const last = new Map(entries.map(entry => [entry.name, entry]));
      for (const entry of last.values()) {
        if (typeof entry.name !== 'string' || !entry.name || typeof entry.command !== 'string' || !entry.command ||
          (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string')))) {
          throw new McpConfigError('Invalid legacy MCP configuration. Correct the workspace configuration before migration.');
        }
        if (!this.list(`workspace:${id}`).some(record => record.name === entry.name)) {
          this.save({ scope: `workspace:${id}`, name: entry.name, enabled: true,
            connection: { type: 'stdio', command: entry.command, ...(entry.args ? { args: entry.args } : {}) } });
        }
      }
      this.db.prepare('INSERT INTO mcp_workspace_migrations VALUES (?)').run(id);
    })();
  }
}
