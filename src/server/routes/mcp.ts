import { Router, type Request, type Response } from 'express';
import { McpConfigError } from '../storage/mcp-config-store.js';
import { mcpConfigService, type McpConfigService } from '../services/mcp-config-service.js';
import { mcpOAuthService, McpOAuthService } from '../services/mcp-oauth-service.js';
import { mcpSessionCoordinator } from '../services/mcp-session-coordinator.js';
import { connectManagedMcp, managedMcpError, sanitizeMcpValue } from '../services/managed-mcp-client.js';
import { homedir } from 'node:os';

export function createMcpRouter(service: McpConfigService = mcpConfigService): Router {
  const router = Router();
  const oauth = service === mcpConfigService ? mcpOAuthService : new McpOAuthService(service);
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    void fn(req, res).catch(error => {
      res.status(error instanceof McpConfigError ? error.status : 500).json({
        error: error instanceof McpConfigError ? error.message : 'MCP operation failed',
      });
    });
  };
  router.get('/', handle(async (req, res) => res.json({ servers: await service.list(String(req.query.scope ?? 'global')) })));
  router.get('/effective', handle(async (req, res) => {
    const records = await service.effective(String(req.query.workspaceId ?? ''));
    res.json({ servers: records.map(record => service.view(record)) });
  }));
  router.get('/applications', handle(async (_req, res) => res.json({ applications: mcpSessionCoordinator.status() })));
  router.post('/applications/:sessionId/retry', handle(async (req, res) => {
    mcpSessionCoordinator.retry(req.params.sessionId);
    res.status(202).json({ applications: mcpSessionCoordinator.status(req.params.sessionId) });
  }));
  router.post('/:id/oauth', handle(async (req, res) => res.status(201).json(await oauth.start(req.params.id))));
  router.get('/oauth/:operationId', handle(async (req, res) => res.json(oauth.status(req.params.operationId))));
  router.delete('/oauth/:operationId', handle(async (req, res) => { oauth.cancel(req.params.operationId); res.status(204).end(); }));
  const probe = handle(async (req, res) => {
    const record = service.store.mcp.get(req.params.id);
    if (!record?.connection) throw new McpConfigError('MCP service connection not found', 404);
    const workspaceId = record.scope.startsWith('workspace:') ? record.scope.slice(10) : req.body?.workspaceId;
    const workspace = workspaceId ? await service.store.get(workspaceId) : undefined;
    if (workspaceId && !workspace) throw new McpConfigError('Workspace not found', 404);
    let connected: Awaited<ReturnType<typeof connectManagedMcp>> | undefined;
    try {
      connected = await connectManagedMcp(record, workspace?.folderPath ?? homedir(),
        record.connection.type !== 'stdio' && record.connection.oauth ? oauth.provider(record) : undefined);
      const tools: Array<{ name: string; description?: string }> = [];
      if (connected.client.getServerCapabilities()?.tools) {
        let cursor: string | undefined;
        do {
          const page = await connected.client.listTools({ cursor });
          tools.push(...page.tools.map(tool => ({ name: tool.name, description: tool.description })));
          cursor = page.nextCursor;
        } while (cursor);
      }
      res.json({ connection: { state: 'connected', tools: sanitizeMcpValue(service.store.mcp.get(record.id) ?? record, tools) } });
    } catch (error) {
      const current = service.store.mcp.get(record.id);
      const authorizationRequired = record.connection.type !== 'stdio' && record.connection.oauth && !current?.oauthState?.tokens;
      res.json({ connection: { state: authorizationRequired ? 'authorization_required' : 'failed', error: managedMcpError(error) } });
    } finally { await connected?.close(); }
  });
  router.post('/:id/test', probe);
  router.post('/:id/tools', probe);
  router.post('/', handle(async (req, res) => res.status(201).json({ server: await service.save(req.body) })));
  router.put('/:id', handle(async (req, res) => res.json({ server: await service.save({ ...req.body, id: req.params.id }) })));
  router.post('/import', handle(async (req, res) => res.status(201).json({
    servers: await service.import(req.body.scope, req.body.configuration),
  })));
  router.delete('/:id', handle(async (req, res) => {
    await service.delete(req.params.id, Number(req.query.revision));
    res.status(204).end();
  }));
  return router;
}
