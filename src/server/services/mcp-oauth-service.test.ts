import '../test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../storage/sqlite-store.js';
import { McpConfigService } from './mcp-config-service.js';
import { McpOAuthService } from './mcp-oauth-service.js';

it('owns real PKCE callbacks, rejects wrong state and stale callbacks, and refreshes concurrently once', async () => {
  const store = new SqliteStore(':memory:');
  const config = new McpConfigService(store);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let origin = '';
  let challenge = '';
  let refreshes = 0;
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: origin,
    authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
  }));
  app.post('/token', async (req, res) => {
    assert.equal(req.body.resource, `${origin}/mcp`);
    if (req.body.grant_type === 'refresh_token') {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 40));
      res.json({ access_token: 'refreshed-secret', refresh_token: 'rotated-secret', token_type: 'Bearer', expires_in: 3600 });
    } else {
      assert.equal(createHash('sha256').update(req.body.code_verifier).digest('base64url'), challenge);
      res.json({ access_token: 'first-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 1 });
    }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let now = Date.now();
  const oauth = new McpOAuthService(config, () => now);
  try {
    const entry = await config.save({ scope: 'global', name: 'oauth', enabled: true,
      connection: { type: 'http', url: `${origin}/mcp`, oauth: { clientId: 'test-client' } } });
    const operation = await oauth.start(entry.id);
    const url = new URL(operation.authorizationUrl!);
    challenge = url.searchParams.get('code_challenge')!;
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'test-code');
    callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('iss', origin);
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(oauth.status(operation.id).state, 'authorized');
    assert.ok(!JSON.stringify(await config.list('global')).includes('first-secret'));
    now += 5000;
    const record = store.mcp.get(entry.id)!;
    const tokens = await Promise.all(Array.from({ length: 4 }, () => oauth.provider(record).tokens()));
    assert.equal(refreshes, 1);
    assert.ok(tokens.every(token => token?.access_token === 'refreshed-secret'));
    assert.equal(store.mcp.get(entry.id)?.oauthState?.tokens?.refresh_token, 'rotated-secret');
    const stale = await oauth.start(entry.id);
    const staleUrl = new URL(stale.authorizationUrl!);
    const staleCallback = new URL(staleUrl.searchParams.get('redirect_uri')!);
    staleCallback.searchParams.set('state', staleUrl.searchParams.get('state')!);
    staleCallback.searchParams.set('code', 'old-code');
    await config.save({ id: entry.id, expectedRevision: entry.revision, scope: 'global', name: 'oauth', enabled: true,
      connection: { type: 'http', url: `${origin}/changed`, oauth: { clientId: 'test-client' } } });
    await assert.rejects(fetch(staleCallback));
    assert.equal(store.mcp.get(entry.id)?.oauthState, undefined);
  } finally {
    oauth.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
