import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startManagedMcpHttpFixture } from '../../../scripts/fixtures/managed-mcp-http-fixture.js';
import { connectManagedMcp, managedMcpFetch } from './managed-mcp-client.js';

for (const type of ['http', 'sse'] as const) it(`performs real ${type} tool calls with the configured headers`, async () => {
  const fixture = await startManagedMcpHttpFixture();
  const connected = await connectManagedMcp({ id: type, scope: 'global', name: type, kind: 'server', enabled: true, revision: 1,
    connection: { type, url: `${fixture.base}/${type}`, headers: { Authorization: 'Bearer manual-test-secret', 'X-API-Key': 'custom-test-secret' } },
  }, process.cwd());
  try {
    assert.equal((await connected.client.listTools()).tools[0].name, 'remote_echo');
    const result = await connected.client.callTool({ name: 'remote_echo', arguments: { message: 'remote call completed' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'remote call completed' }]);
    assert.deepEqual(fixture.received, [{ authorization: 'Bearer manual-test-secret', key: 'custom-test-secret', message: 'remote call completed' }]);
  } finally { await connected.close(); await fixture.close(); }
});

it('never replays credential headers or request bodies across an origin redirect', async () => {
  let received = false;
  const target = createServer((_req, res) => { received = true; res.end('must not receive credentials'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${(target.address() as { port: number }).port}/` }).end(); });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(managedMcpFetch(`http://127.0.0.1:${(source.address() as { port: number }).port}`, {
      method: 'POST', headers: { Authorization: 'Bearer secret', 'X-API-Key': 'custom-secret' }, body: 'sensitive payload',
    }), /Cross-origin/);
    assert.equal(received, false);
  } finally {
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
  }
});
