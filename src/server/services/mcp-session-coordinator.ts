import { EventEmitter } from 'node:events';
import type { ManagedMcpRecord, McpSessionApplication } from '@comate/api-contracts';
import { mcpConfigService, type McpConfigService } from './mcp-config-service.js';
import { managedMcpGateway, type ManagedMcpGateway, type ManagedMcpSession } from './managed-mcp-gateway.js';

interface PendingUpdate { epoch: number; records: Map<string, ManagedMcpRecord> }

export class McpSessionCoordinator extends EventEmitter {
  private epoch = 0;
  private applications = new Map<string, Map<string, McpSessionApplication>>();
  private pending = new Map<string, PendingUpdate>();
  private running = new Map<string, Promise<void>>();
  private releases = new Map<string, Map<string, () => void>>();
  constructor(readonly config: McpConfigService, readonly gateway: ManagedMcpGateway) {
    super();
    config.on('change', this.onChange);
    gateway.on('closed', this.onClosed);
  }
  status(sessionId?: string): McpSessionApplication[] {
    return [...this.applications.entries()].filter(([id]) => !sessionId || id === sessionId).flatMap(([, records]) => [...records.values()].map(record => ({ ...record })));
  }
  private effective(session: ManagedMcpSession): Map<string, ManagedMcpRecord> {
    const records = new Map(this.config.store.mcp.list('global').map(record => [record.name, record]));
    for (const record of this.config.store.mcp.list(`workspace:${session.workspaceId}`)) records.set(record.name, record);
    return new Map([...records].filter(([, record]) => record.kind === 'server' && record.enabled && record.connection));
  }
  private onChange = (change: { scope?: string; id?: string; authorization?: boolean }) => {
    for (const session of this.gateway.contexts()) {
      if (change.scope && change.scope !== 'global' && change.scope !== `workspace:${session.workspaceId}`) continue;
      this.queue(session, change.authorization ? change.id : undefined);
    }
  };
  retry(sessionId: string): void { this.queue(this.gateway.context(sessionId), undefined, true); }
  private queue(session: ManagedMcpSession, forceId?: string, retry = false): void {
    const next = this.effective(session);
    const current = new Map([...session.records.values()].map(record => [record.name, record]));
    const desired = this.pending.get(session.sessionId)?.records ?? current;
    const names = new Set([...desired.keys(), ...next.keys()]);
    const applications = this.applications.get(session.sessionId) ?? new Map<string, McpSessionApplication>();
    const releases = this.releases.get(session.sessionId) ?? new Map<string, () => void>();
    const epoch = ++this.epoch;
    let changed = false;
    for (const name of names) {
      const old = desired.get(name), record = next.get(name);
      if (old?.id === record?.id && old?.revision === record?.revision &&
          !(forceId && record?.id === forceId) && !(retry && applications.get(name)?.state === 'failed')) continue;
      changed = true;
      for (const id of new Set([old?.id, record?.id, current.get(name)?.id].filter((id): id is string => Boolean(id)))) {
        if (!releases.has(id)) session.fences.set(id, new Promise<void>(resolve => releases.set(id, resolve)));
      }
      applications.set(name, { sessionId: session.sessionId, workspaceId: session.workspaceId, backend: session.backend, name,
        entryId: record?.id ?? old?.id, desired: epoch, applied: applications.get(name)?.applied ?? 0, state: 'pending' });
    }
    if (!changed) return;
    this.applications.set(session.sessionId, applications);
    this.releases.set(session.sessionId, releases);
    this.pending.set(session.sessionId, { epoch, records: next });
    this.emit('change', session.sessionId, this.status(session.sessionId));
    this.start(session);
  }
  private start(session: ManagedMcpSession): void {
    if (this.running.has(session.sessionId)) return;
    const work = Promise.resolve().then(() => this.apply(session)).finally(() => {
      this.running.delete(session.sessionId);
      if (!session.closed && this.pending.has(session.sessionId)) this.start(session);
    });
    this.running.set(session.sessionId, work);
  }
  private async drained(session: ManagedMcpSession, ids: string[]): Promise<void> {
    while (!session.closed && ids.some(id => (session.leases.get(id) ?? 0) > 0)) {
      await new Promise<void>(resolve => {
        const wake = () => { this.gateway.off('drained', wake); this.gateway.off('closed', wake); resolve(); };
        this.gateway.once('drained', wake); this.gateway.once('closed', wake);
      });
    }
  }
  private async apply(session: ManagedMcpSession): Promise<void> {
    while (!session.closed && this.pending.has(session.sessionId)) {
      const update = this.pending.get(session.sessionId)!;
      const applications = this.applications.get(session.sessionId)!;
      const releases = this.releases.get(session.sessionId)!;
      const ids = [...releases.keys()];
      await this.drained(session, ids);
      if (session.closed) return;
      if (this.pending.get(session.sessionId) !== update) continue;
      const affected = [...applications.values()].filter(application => application.state === 'pending');
      affected.forEach(application => { application.state = 'applying'; });
      this.emit('change', session.sessionId, this.status(session.sessionId));
      try {
        for (const record of update.records.values()) if (ids.includes(record.id)) await this.gateway.client(session, record);
        const records = new Map(session.records);
        for (const application of affected) {
          for (const [id, record] of records) if (record.name === application.name) records.delete(id);
          const replacement = update.records.get(application.name);
          if (replacement) records.set(replacement.id, replacement);
        }
        session.records = records;
        for (const [alias, target] of session.aliases) if (ids.includes(target.recordId)) session.aliases.delete(alias);
        const tools = await this.gateway.listTools(session.sessionId);
        if (ids.some(id => session.records.has(id) && session.statuses.get(id)?.state === 'failed')) throw new Error('MCP tool discovery failed');
        await this.gateway.notify(session);
        if (!session.refreshInventory) throw new Error('Backend inventory is unavailable');
        await session.refreshInventory(tools);
        if (session.closed) return;
        for (const [key, client] of session.clients) {
          const id = key.split(':')[0];
          if (!ids.includes(id)) continue;
          const record = session.records.get(id);
          if (!record || key !== `${record.id}:${record.revision}:${record.oauthState?.obtainedAt ?? 0}`) { session.clients.delete(key); await (await client).close(); }
        }
        for (const id of ids) session.blocked.delete(id);
        for (const application of affected) if (application.desired <= update.epoch) {
          application.state = 'applied'; application.applied = application.desired; delete application.error;
        }
      } catch {
        if (session.closed) return;
        for (const id of ids) session.blocked.add(id);
        for (const application of affected) if (application.desired <= update.epoch) {
          application.state = 'failed'; application.error = 'Saved, but this session could not apply the MCP configuration. Retry after checking the connection.';
        }
      }
      if (this.pending.get(session.sessionId) === update) {
        this.pending.delete(session.sessionId);
        for (const [id, release] of releases) { session.fences.delete(id); release(); }
        releases.clear();
      }
      this.emit('change', session.sessionId, this.status(session.sessionId));
    }
  }
  async settled(sessionId: string): Promise<void> { while (this.running.has(sessionId)) await this.running.get(sessionId); }
  private onClosed = (id: string) => {
    this.pending.delete(id); this.applications.delete(id);
    for (const release of this.releases.get(id)?.values() ?? []) release();
    this.releases.delete(id);
  };
  dispose(): void {
    this.config.off('change', this.onChange); this.gateway.off('closed', this.onClosed);
    for (const id of this.releases.keys()) this.onClosed(id);
  }
}

export const mcpSessionCoordinator = new McpSessionCoordinator(mcpConfigService, managedMcpGateway);
