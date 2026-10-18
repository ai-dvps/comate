import { Router, type Request, type Response } from 'express';
import { McpConfigError } from '../storage/mcp-config-store.js';
import { mcpConfigService, type McpConfigService } from '../services/mcp-config-service.js';

export function createMcpRouter(service: McpConfigService = mcpConfigService): Router {
  const router = Router();
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
