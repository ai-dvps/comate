import { Router, json, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { diagLog } from '../utils/diag-logger.js';

export interface McpHttpAuthorization<TContext = unknown> {
  ok: boolean;
  status?: number;
  error?: string;
  context?: TContext;
}

export interface StatelessMcpHttpRouterOptions<TDeps, TAuthContext = unknown> {
  /** MCP server identity reported to clients. */
  name: string;
  version: string;
  /** Model-facing guidance returned during MCP initialization. */
  instructions?: string;
  /** Per-surface Bearer token (each MCP surface owns its secret). */
  token?: string;
  authorizeRequest?: (
    req: Request,
    sessionId: string,
  ) => Promise<McpHttpAuthorization<TAuthContext>> | McpHttpAuthorization<TAuthContext>;
  /** diagLog tag for request failures. */
  logTag: string;
  /** Resolve per-session deps; null means the session is not eligible (404). */
  depsFor: (sessionId: string, authContext?: TAuthContext) => Promise<TDeps | null>;
  /** Register the surface's tools on the fresh per-POST server. */
  registerTools: (server: McpServer, sessionId: string, deps: TDeps) => void;
}

/**
 * Shared plumbing for stateless MCP-over-HTTP surfaces (browser MCP,
 * scheduled-task MCP): Bearer-token auth, router-local JSON parsing (the
 * production mount precedes the global express.json()), one self-contained
 * McpServer + StreamableHTTPServerTransport per POST, and a 405 for non-POST
 * methods. Surface-specific content (tool sets, deps) stays with the caller.
 */
export function createStatelessMcpHttpRouter<TDeps, TAuthContext = unknown>(options: StatelessMcpHttpRouterOptions<TDeps, TAuthContext>): Router {
  const router = Router();

  if (options.token) {
    router.use((req: Request, res: Response, next) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${options.token}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  router.use('/:sessionId', async (req: Request, res: Response, next) => {
    if (!options.authorizeRequest) return next();
    const authorization = await options.authorizeRequest(req, req.params.sessionId);
    if (!authorization.ok) {
      res.status(authorization.status ?? 401).json({ error: authorization.error ?? 'Unauthorized' });
      return;
    }
    res.locals.mcpAuthorization = authorization.context;
    next();
  });

  router.use(json());

  router.post('/:sessionId', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const deps = await options.depsFor(sessionId, res.locals.mcpAuthorization as TAuthContext | undefined);
    if (!deps) {
      res.status(404).json({ error: 'Session not found or not eligible' });
      return;
    }
    const server = new McpServer(
      { name: options.name, version: options.version },
      options.instructions ? { instructions: options.instructions } : undefined,
    );
    options.registerTools(server, sessionId, deps);

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
      diagLog(`[${options.logTag}] request failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
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
