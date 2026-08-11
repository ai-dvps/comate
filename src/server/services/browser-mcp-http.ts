/**
 * Browser MCP over HTTP (U6, KTD-6): the embedded browser's MCP tool surface,
 * served from the sidecar over the MCP Streamable HTTP transport so BOTH
 * agent backends consume it — claude via its http MCP config, opencode via a
 * remote MCP entry. This replaces the claude-SDK in-process `createSdkMcpServer`
 * hosting, which only the claude runtime could reach.
 *
 * Routing: `/mcp/browser/:sessionId` — the path carries the Comate session id
 * so tool handlers bind to that session's embedded browser (BrowserService is
 * session-keyed). Auth: an audience-scoped per-runtime task capability bound
 * to the path session and workspace. Stateless transports (one per POST) keep
 * lifecycle trivial — tool handlers hold all state in BrowserService.
 * Transport plumbing is shared with other MCP surfaces in mcp-http-router.ts.
 */

import { Router } from 'express';
import {
  BROWSER_MCP_INSTRUCTIONS,
  buildBrowserToolDefinitions,
  type BrowserMcpDeps,
} from './browser-mcp.js';
import { createStatelessMcpHttpRouter } from './mcp-http-router.js';
import {
  sessionCapabilityService,
  type SessionCapabilityService,
} from './session-capability-service.js';

export interface BrowserMcpHttpDeps {
  workspaceId: string;
  workspaceFolder?: string;
  approvalRequester: BrowserMcpDeps['approvalRequester'];
}

interface AuthorizedBrowserMcpHttpDeps extends BrowserMcpHttpDeps {
  runtimeGeneration: string;
  apiBrokerAuthorized: boolean;
  capabilityId: string;
  principalId: string;
  isInvocationCurrent: () => boolean;
}

interface BrowserMcpAuthorization {
  workspaceId: string;
  runtimeGeneration: string;
  apiBrokerAuthorized: boolean;
  capabilityId: string;
  principalId: string;
  isInvocationCurrent: () => boolean;
}

function isLoopbackHost(rawHost: string | undefined): boolean {
  if (!rawHost || rawHost.includes(',')) return false;
  try {
    const hostname = new URL(`http://${rawHost}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host?.toLowerCase();
  } catch {
    return false;
  }
}

export function createBrowserMcpHttpRouter(
  depsFor: (sessionId: string) => Promise<BrowserMcpHttpDeps | null>,
  options?: { capabilities?: SessionCapabilityService },
): Router {
  const capabilities = options?.capabilities ?? sessionCapabilityService;
  return createStatelessMcpHttpRouter<AuthorizedBrowserMcpHttpDeps, BrowserMcpAuthorization>({
    name: 'comate-browser',
    version: '0.3.0',
    instructions: BROWSER_MCP_INSTRUCTIONS,
    logTag: 'browser-mcp-http',
    authorizeRequest: (req, sessionId) => {
      if (!isLoopbackHost(req.headers.host) || !originAllowed(req.headers.origin, req.headers.host)) {
        return { ok: false, status: 403, error: 'Invalid loopback origin' };
      }
      const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
      const resolved = match
        ? capabilities.resolveForAudience(match[1], 'browser-mcp', { sessionId })
        : null;
      if (!resolved) return { ok: false, status: 401, error: 'Unauthorized' };
      return {
        ok: true,
        context: {
          workspaceId: resolved.workspaceId,
          runtimeGeneration: resolved.runtimeGeneration,
          apiBrokerAuthorized: Boolean(match && capabilities.resolveForAudience(
            match[1],
            'api-broker',
            {
              sessionId,
              workspaceId: resolved.workspaceId,
              runtimeGeneration: resolved.runtimeGeneration,
            },
          )),
          capabilityId: resolved.capabilityId,
          principalId: `${resolved.workspaceId}:${resolved.sessionId}:${resolved.botId ?? 'task'}`,
          isInvocationCurrent: () => capabilities.isAudienceCapabilityCurrent(
            resolved.capabilityId,
            'browser-mcp',
            {
              sessionId,
              workspaceId: resolved.workspaceId,
              runtimeGeneration: resolved.runtimeGeneration,
            },
          ),
        },
      };
    },
    depsFor: async (sessionId, auth) => {
      if (!auth) return null;
      const deps = await depsFor(sessionId);
      return deps?.workspaceId === auth.workspaceId
        ? {
            ...deps,
            runtimeGeneration: auth.runtimeGeneration,
            apiBrokerAuthorized: auth.apiBrokerAuthorized,
            capabilityId: auth.capabilityId,
            principalId: auth.principalId,
            isInvocationCurrent: auth.isInvocationCurrent,
          }
        : null;
    },
    registerTools: (server, sessionId, deps) => {
      for (const def of buildBrowserToolDefinitions({
        sessionId,
        workspaceId: deps.workspaceId,
        workspaceFolder: deps.workspaceFolder,
        runtimeGeneration: deps.runtimeGeneration,
        apiBrokerAuthorized: deps.apiBrokerAuthorized,
        capabilityId: deps.capabilityId,
        principalId: deps.principalId,
        isInvocationCurrent: deps.isInvocationCurrent,
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
