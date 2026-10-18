import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigService } from './mcp-config-service.js';

describe('MCP configuration service', () => {
  it('fully overrides, disables and restores global inheritance without sharing credentials', async () => {
    const store = new SqliteStore(':memory:');
    const ws = await store.create({ name: 'workspace', folderPath: '/tmp' });
    const service = new McpConfigService(store);
    const global = await service.save({ scope: 'global', name: 'remote', enabled: true,
      connection: { type: 'http', url: 'https://global.example/mcp', headers: { Authorization: 'sentinel-secret' } } });
    assert.equal((await service.effective(ws.id))[0].id, global.id);
    const override = await service.save({ scope: `workspace:${ws.id}`, name: 'remote', enabled: true,
      connection: { type: 'http', url: 'https://local.example/mcp' } });
    assert.equal((await service.effective(ws.id))[0].connection?.type, 'http');
    assert.ok(!JSON.stringify(await service.list(`workspace:${ws.id}`)).includes('sentinel-secret'));
    assert.ok(!JSON.stringify((await service.effective(ws.id))[0]).includes('sentinel-secret'));
    await service.delete(override.id, override.revision);
    const disabled = await service.save({ scope: `workspace:${ws.id}`, name: 'remote', enabled: false, kind: 'disabled' });
    assert.deepEqual(await service.effective(ws.id), []);
    await service.delete(disabled.id, disabled.revision);
    assert.equal((await service.effective(ws.id))[0].id, global.id);
    store.close();
  });

  it('imports atomically and preserves secrets when only toggling an entry', async () => {
    const store = new SqliteStore(':memory:');
    const service = new McpConfigService(store);
    const [record] = await service.import('global', { mcpServers: {
      example: { command: 'node', args: ['a b'], env: { KEY: 'sentinel-secret' } },
    } });
    await service.save({ id: record.id, expectedRevision: record.revision, scope: 'global', name: 'example', enabled: false });
    assert.equal(store.mcp.get(record.id)?.connection?.type, 'stdio');
    assert.ok(JSON.stringify(store.mcp.get(record.id)).includes('sentinel-secret'));
    await assert.rejects(service.import('global', { mcpServers: {
      good: { command: 'node' }, bad: { command: 'node', unsupported: 'value' },
    } }));
    assert.equal((await service.list('global')).length, 1);
    const publicView = JSON.stringify(await service.list('global'));
    assert.ok(!publicView.includes('sentinel-secret'));
    assert.ok(!publicView.includes('a b'));
    store.close();
  });
});
