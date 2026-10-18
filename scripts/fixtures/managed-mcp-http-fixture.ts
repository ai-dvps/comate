import express from 'express';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

export async function startManagedMcpHttpFixture(options: { oauth?: boolean; oidc?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  let base = '';
  const challenges = new Map<string, string>();
  app.get('/.well-known/oauth-protected-resource/http', (_req, res) => res.json({ resource: `${base}/http`, authorization_servers: [base] }));
  const metadata = () => ({ issuer: base,
    authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    ...(options.oidc ? { jwks_uri: `${base}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], authorization_response_iss_parameter_supported: true } : {}),
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => options.oidc ? res.sendStatus(404) : res.json(metadata()));
  app.get('/.well-known/openid-configuration', (_req, res) => res.json(metadata()));
  app.get('/authorize', (req, res) => {
    const code = randomUUID();
    challenges.set(code, String(req.query.code_challenge));
    const redirect = new URL(String(req.query.redirect_uri));
    redirect.searchParams.set('code', code); redirect.searchParams.set('state', String(req.query.state)); redirect.searchParams.set('iss', base);
    res.redirect(redirect.href);
  });
  app.post('/token', (req, res) => {
    const challenge = challenges.get(req.body.code);
    challenges.delete(req.body.code);
    if (!challenge || createHash('sha256').update(String(req.body.code_verifier)).digest('base64url') !== challenge || req.body.resource !== `${base}/http`) {
      res.status(400).json({ error: 'invalid_grant' }); return;
    }
    res.json({ access_token: 'fixture-oauth-access-secret', refresh_token: 'fixture-oauth-refresh-secret', token_type: 'Bearer', expires_in: 3600 });
  });
  const connections = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport | SSEServerTransport }>();
  const received: Array<{ authorization?: string; key?: string; message: string }> = [];
  const mcp = (authorization?: string, key?: string) => {
    const server = new McpServer({ name: 'remote-fixture', version: '1' });
    server.registerTool('remote_echo', { inputSchema: { message: z.string(), delay: z.number().optional() } }, async ({ message, delay }) => {
      received.push({ authorization, key, message });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return { content: [{ type: 'text', text: message }] };
    });
    return server;
  };
  app.all('/http', async (req, res) => {
    if (options.oauth && req.headers.authorization !== 'Bearer fixture-oauth-access-secret') {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/http"`);
      res.sendStatus(401); return;
    }
    const id = req.headers['mcp-session-id'];
    let connection = typeof id === 'string' ? connections.get(id) : undefined;
    if (!connection && req.method === 'POST' && !id) {
      const server = mcp(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: id => { connections.set(id, { mcp: server, transport }); } });
      await server.connect(transport);
      connection = { mcp: server, transport };
    }
    if (!connection || !(connection.transport instanceof StreamableHTTPServerTransport)) { res.sendStatus(404); return; }
    await connection.transport.handleRequest(req, res, req.body);
  });
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const server = mcp(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
    connections.set(transport.sessionId, { mcp: server, transport });
    res.on('close', () => { connections.delete(transport.sessionId); void server.close(); });
    await server.connect(transport);
  });
  app.post('/messages', async (req, res) => {
    const connection = connections.get(String(req.query.sessionId));
    if (!connection || !(connection.transport instanceof SSEServerTransport)) { res.sendStatus(404); return; }
    await connection.transport.handlePostMessage(req, res, req.body);
  });
  const http = createServer(app);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  return { base, received, close: async () => {
    await Promise.allSettled([...connections.values()].map(connection => connection.mcp.close()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}
