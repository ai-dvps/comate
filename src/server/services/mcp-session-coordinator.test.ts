import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigService } from './mcp-config-service.js';
import { ManagedMcpGateway } from './managed-mcp-gateway.js';
import { McpSessionCoordinator } from './mcp-session-coordinator.js';

it('waits for real dispatched calls, switches without ending a turn, and isolates an override', async () => {
  const store = new SqliteStore(':memory:');
  const config = new McpConfigService(store);
  const workspace = await store.create({ name: 'one', folderPath: process.cwd() });
  const other = await store.create({ name: 'two', folderPath: process.cwd() });
  const connection = { type: 'stdio' as const, command: process.execPath,
    args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts')] };
  const entry = await config.save({ scope: 'global', name: 'example', enabled: true, connection });
  await config.save({ scope: `workspace:${other.id}`, name: 'example', enabled: true, connection });
  const gateway = new ManagedMcpGateway(config);
  const coordinator = new McpSessionCoordinator(config, gateway);
  const context = await gateway.register({ sessionId: 'one', workspaceId: workspace.id, directory: process.cwd(), generation: '1', backend: 'test' });
  const independent = await gateway.register({ sessionId: 'two', workspaceId: other.id, directory: process.cwd(), generation: '2', backend: 'test' });
  context.authorizeTool = independent.authorizeTool = async (_name, input) => input;
  context.refreshInventory = async names => { assert.deepEqual(names, []); };
  try {
    const tool = (await gateway.listTools('one'))[0].name;
    const running = gateway.callTool('one', tool, { message: 'old-completed', delay: 120 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(context.leases.get(entry.id), 1);
    await config.save({ id: entry.id, expectedRevision: entry.revision, scope: 'global', name: 'example', enabled: false });
    assert.equal(coordinator.status('one')[0].state, 'pending');
    assert.ok(context.records.has(entry.id));
    assert.deepEqual(coordinator.status('two'), []);
    assert.ok(JSON.stringify(await running).includes('old-completed'));
    await coordinator.settled('one');
    assert.ok(!context.records.has(entry.id));
    assert.equal(coordinator.status('one')[0].state, 'applied');
    await assert.rejects(gateway.callTool('one', tool, { message: 'must-not-dispatch' }));
    assert.equal(independent.records.size, 1);
  } finally { coordinator.dispose(); await gateway.close('one'); await gateway.close('two'); store.close(); }
});
