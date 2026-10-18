import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigService } from '../services/mcp-config-service.js';
import { createMcpRouter } from './mcp.js';
import { createLoopbackAuthMiddleware } from '../services/security/loopback-auth.js';

it('protects MCP management and never returns saved connection secrets', async () => {
  const store = new SqliteStore(':memory:');
  const app = express();
  app.use(express.json());
  app.use(createLoopbackAuthMiddleware({ getDesktopToken: () => 'desktop-test-token', resolveSessionToken: () => null }));
  app.use('/api/mcp', createMcpRouter(new McpConfigService(store)));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/mcp`;
  const headers = { Authorization: 'Bearer desktop-test-token', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url)).status, 401);
    const added = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      scope: 'global', name: 'example', enabled: true,
      connection: { type: 'http', url: 'https://example.com/mcp?key=url-secret', headers: { Authorization: 'header-secret' } },
    }) });
    assert.equal(added.status, 201);
    const response = await added.text();
    assert.doesNotMatch(response, /url-secret|header-secret/);
    const { server: record } = JSON.parse(response);
    const stale = await fetch(`${url}/${record.id}`, { method: 'PUT', headers, body: JSON.stringify({
      scope: 'global', name: 'example', enabled: false, expectedRevision: 99,
    }) });
    assert.equal(stale.status, 409);
    const listing = await fetch(url, { headers });
    assert.doesNotMatch(await listing.text(), /url-secret|header-secret/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});
