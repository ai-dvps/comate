import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './sqlite-store.js';

describe('MCP scoped storage', () => {
  it('persists isolated scopes and encrypts connection material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-storage-'));
    const file = join(dir, 'test.db');
    let store = new SqliteStore(file);
    const connection = { type: 'stdio' as const, command: 'node', args: ['a b'], env: { API_KEY: 'mcp-secret-sentinel' } };
    const global = store.mcp.save({ scope: 'global', name: 'example', connection, enabled: true });
    store.mcp.save({ scope: 'workspace:w1', name: 'example', connection, enabled: true });
    store.close();
    assert.ok(!readFileSync(file).includes('mcp-secret-sentinel'));
    store = new SqliteStore(file);
    assert.deepEqual(store.mcp.get(global.id)?.connection, connection);
    assert.equal(store.mcp.list('global').length, 1);
    assert.equal(store.mcp.list('workspace:w1').length, 1);
    store.mcp.deleteScope('workspace:w1');
    assert.equal(store.mcp.list('global').length, 1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects stale revisions and rolls back a failed batch', () => {
    const store = new SqliteStore(':memory:');
    const input = { scope: 'global', name: 'example', connection: { type: 'stdio' as const, command: 'node' }, enabled: true };
    const first = store.mcp.save(input);
    assert.throws(() => store.mcp.save({ ...input, id: first.id, expectedRevision: 9 }), /revision/i);
    assert.throws(() => store.mcp.import('global', [input, input]), /already exists/i);
    assert.equal(store.mcp.list('global').length, 1);
    assert.equal(store.mcp.get(first.id)?.revision, 1);
    store.close();
  });

  it('migrates legacy argv exactly once and keeps the last duplicate', async () => {
    const store = new SqliteStore(':memory:');
    const ws = await store.create({ name: 'legacy', folderPath: '/tmp', mcpServers: [
      { name: 'example', command: 'old', args: [] },
      { name: 'example', command: 'node', args: ['a b', '--flag'] },
    ] });
    store.mcp.migrateWorkspace(ws.id, ws.mcpServers);
    const record = store.mcp.list(`workspace:${ws.id}`)[0];
    assert.deepEqual(record.connection, { type: 'stdio', command: 'node', args: ['a b', '--flag'] });
    store.mcp.delete(record.id, record.revision);
    store.mcp.migrateWorkspace(ws.id, ws.mcpServers);
    assert.equal(store.mcp.list(`workspace:${ws.id}`).length, 0);
    store.close();
  });
});
