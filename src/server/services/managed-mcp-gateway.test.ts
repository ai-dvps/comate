import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigService } from './mcp-config-service.js';
import { ManagedMcpGateway } from './managed-mcp-gateway.js';

it('serves isolated real MCP tools, prompts and resources over authenticated HTTP', async () => {
  const store = new SqliteStore(':memory:');
  const workspace = await store.create({ name: 'gateway', folderPath: process.cwd() });
  const service = new McpConfigService(store);
  await service.save({ scope: 'global', name: 'example', enabled: true, connection: {
    type: 'stdio', command: process.execPath,
    args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts')],
  } });
  const gateway = new ManagedMcpGateway(service);
  const context = await gateway.register({ sessionId: 'session1', workspaceId: workspace.id, directory: process.cwd(), generation: 'g1', backend: 'test' });
  let approvals = 0;
  context.authorizeTool = async (_name, input) => { approvals++; return input; };
  const app = express();
  app.use('/mcp/managed', gateway.router(token => token === 'test-token'));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/managed/session1`);
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(url)).status, 401);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-token' } } }));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
    assert.ok(tools.tools[0].name.length < 40);
    const result = await client.callTool({ name: tools.tools[0].name, arguments: { message: 'hello' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(approvals, 1);
    const prompt = (await client.listPrompts()).prompts[0];
    assert.equal((await client.getPrompt({ name: prompt.name, arguments: { name: 'World' } })).messages[0].content.text, 'Hello World');
    const resource = (await client.listResources()).resources[0];
    const read = await client.readResource({ uri: resource.uri });
    assert.equal(read.contents[0].uri, resource.uri);
    assert.equal(read.contents[0].text, 'fixture resource');
  } finally {
    await client.close();
    await gateway.close('session1');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
