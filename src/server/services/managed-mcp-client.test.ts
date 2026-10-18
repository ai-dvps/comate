import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { connectManagedMcp } from './managed-mcp-client.js';

it('connects a real stdio server with exact argv and scoped environment', async () => {
  const connection = await connectManagedMcp({
    id: 'fixture', scope: 'global', name: 'fixture', kind: 'server', enabled: true, revision: 1,
    connection: { type: 'stdio', command: process.execPath,
      args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/fixtures/managed-mcp-fixture.ts'), 'a b'],
      env: { MCP_FIXTURE_SECRET: 'scoped-fixture-value' } },
  }, process.cwd());
  try {
    assert.equal((await connection.client.listTools()).tools[0].name, 'echo');
    const result = await connection.client.callTool({ name: 'echo', arguments: { message: 'hello' } });
    assert.deepEqual(result.structuredContent, { message: 'hello', configured: true, argv: ['a b'] });
    assert.equal((await connection.client.listPrompts()).prompts[0].name, 'greet');
    assert.equal((await connection.client.readResource({ uri: 'fixture://example' })).contents[0].text, 'fixture resource');
  } finally { await connection.close(); }
});
