import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

it('applies the latest of rapid edits, keeps another service running, and never replays a completed call after retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-mcp-drain-'));
  const trace = path.join(directory, 'trace.jsonl');
  const store = new SqliteStore(':memory:');
  const config = new McpConfigService(store);
  const workspace = await store.create({ name: 'coordinator', folderPath: directory });
  const connection = (version: string) => ({ type: 'stdio' as const, command: process.execPath,
    args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts')],
    env: { MCP_FIXTURE_TRACE: trace, MCP_FIXTURE_VERSION: version } });
  const a = await config.save({ scope: 'global', name: 'a', enabled: true, connection: connection('a1') });
  await config.save({ scope: 'global', name: 'b', enabled: true, connection: connection('b1') });
  const gateway = new ManagedMcpGateway(config);
  const coordinator = new McpSessionCoordinator(config, gateway);
  const context = await gateway.register({ sessionId: 'rapid', workspaceId: workspace.id, directory,
    generation: '1', backend: 'test' });
  context.authorizeTool = async (_name, input) => input;
  let rejectRefresh = true;
  context.refreshInventory = async () => { if (rejectRefresh) throw new Error('Native inventory failed'); };
  try {
    const tools = await gateway.listTools('rapid');
    const toolA = tools.find(tool => tool.description?.startsWith('a /'))!.name;
    const toolB = tools.find(tool => tool.description?.startsWith('b /'))!.name;
    const oldA = gateway.callTool('rapid', toolA, { message: 'old-a', delay: 80 });
    const oldB = gateway.callTool('rapid', toolB, { message: 'old-b', delay: 500 });
    await new Promise(resolve => setTimeout(resolve, 20));
    for (let revision = 1; revision <= 3; revision++) await config.save({ id: a.id, expectedRevision: revision,
      scope: 'global', name: 'a', enabled: true, connection: connection(`a${revision + 1}`) });
    await oldA;
    await coordinator.settled('rapid');
    assert.equal(coordinator.status('rapid')[0].state, 'failed');
    await assert.rejects(gateway.callTool('rapid', toolA, { message: 'blocked-call' }));
    assert.ok(JSON.stringify(await oldB).includes('old-b'));
    rejectRefresh = false;
    coordinator.retry('rapid');
    await coordinator.settled('rapid');
    assert.equal(coordinator.status('rapid')[0].state, 'applied');
    await gateway.listTools('rapid');
    await gateway.callTool('rapid', toolA, { message: 'new-a' });
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.stage === 'start').map(event => [event.message, event.version]).sort(), [
      ['new-a', 'a4'], ['old-a', 'a1'], ['old-b', 'b1'],
    ]);
    assert.ok(events.findIndex(event => event.message === 'old-a' && event.stage === 'done') < events.findIndex(event => event.message === 'new-a'));
    assert.equal(events.filter(event => event.message === 'old-b' && event.stage === 'done').length, 1);
  } finally {
    coordinator.dispose(); await gateway.close('rapid'); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
