/**
 * Browser MCP over HTTP (U6, KTD-6): the embedded browser's MCP tool surface,
 * served from the sidecar over the MCP Streamable HTTP transport so BOTH
 * agent backends consume it — claude via its http MCP config, opencode via a
 * remote MCP entry. This replaces the claude-SDK in-process `createSdkMcpServer`
 * hosting, which only the claude runtime could reach.
 *
 * Routing: `/mcp/browser/:sessionId` — the path carries the Comate session id
 * so tool handlers bind to that session's embedded browser (BrowserService is
 * session-keyed). Auth: a random per-sidecar Bearer token; backend configs
 * inject it as a static header. Stateless transports (one per POST) keep
 * lifecycle trivial — tool handlers hold all state in BrowserService.
 */

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildBrowserToolDefinitions, type BrowserMcpDeps } from './browser-mcp.js';
import { diagLog } from '../utils/diag-logger.js';

const token = randomBytes(24).toString('hex');

export function getBrowserMcpToken(): string {
  return token;
}

export interface BrowserMcpHttpDeps {
  workspaceId: string;
  approvalRequester: BrowserMcpDeps['approvalRequester'];
}

export function createBrowserMcpHttpRouter(depsFor: (sessionId: string) => Promise<BrowserMcpHttpDeps>): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  router.post('/:sessionId', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const deps = await depsFor(sessionId);
    const server = new McpServer({
      name: 'comate-browser',
      version: '0.2.0',
    });
    for (const def of buildBrowserToolDefinitions({
      sessionId,
      workspaceId: deps.workspaceId,
      approvalRequester: deps.approvalRequester,
    })) {
      server.registerTool(def.name, {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      }, def.handler as never);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: each POST is self-contained
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      diagLog(`[browser-mcp-http] request failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP request failed' });
      }
    }
  });

  // Non-POST methods are not part of the stateless surface.
  router.all('/:sessionId', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed' });
  });

  return router;
}
