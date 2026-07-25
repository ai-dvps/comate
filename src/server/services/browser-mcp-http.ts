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
 * Transport plumbing is shared with other MCP surfaces in mcp-http-router.ts.
 */

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { buildBrowserToolDefinitions, type BrowserMcpDeps } from './browser-mcp.js';
import { createStatelessMcpHttpRouter } from './mcp-http-router.js';

const token = randomBytes(24).toString('hex');

export function getBrowserMcpToken(): string {
  return token;
}

export interface BrowserMcpHttpDeps {
  workspaceId: string;
  approvalRequester: BrowserMcpDeps['approvalRequester'];
}

export function createBrowserMcpHttpRouter(depsFor: (sessionId: string) => Promise<BrowserMcpHttpDeps>): Router {
  return createStatelessMcpHttpRouter<BrowserMcpHttpDeps>({
    name: 'comate-browser',
    version: '0.2.0',
    token,
    logTag: 'browser-mcp-http',
    depsFor,
    registerTools: (server, sessionId, deps) => {
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
    },
  });
}
