import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Router, json } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema,
  GetPromptRequestSchema, ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema, ErrorCode, McpError, isInitializeRequest,
  type Tool, type Prompt, type Resource, type ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import type { ManagedMcpRecord, McpConnectionStatus } from '@comate/api-contracts';
import { mcpConfigService, type McpConfigService } from './mcp-config-service.js';
import { connectManagedMcp, managedMcpError, sanitizeMcpValue, type ManagedMcpClient } from './managed-mcp-client.js';

export const MANAGED_MCP_SERVER_KEY = 'comate-managed';
export const MANAGED_MCP_AUTH_ENV = 'COMATE_MANAGED_MCP_AUTH';
export const MANAGED_MCP_DISCOVER = 'discover';
export const MANAGED_MCP_INVOKE = 'invoke';
const CODEX_TOOLS: Tool[] = [
  { name: MANAGED_MCP_DISCOVER, description: 'Discover currently configured MCP tools, their source service, opaque tool IDs and JSON input schemas. Call before using invoke: the available services and schemas can change during this chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: MANAGED_MCP_INVOKE, description: 'Call an MCP tool using its opaque ID and arguments from a fresh discover result. Comate applies the current service configuration and asks for approval when required.',
    inputSchema: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['tool', 'arguments'], additionalProperties: false } },
];
export interface ManagedMcpSession {
  sessionId: string; workspaceId: string; directory: string; generation: string; backend: string;
  records: Map<string, ManagedMcpRecord>;
  clients: Map<string, Promise<ManagedMcpClient>>;
  leases: Map<string, number>;
  fences: Map<string, Promise<void>>;
  statuses: Map<string, McpConnectionStatus>;
  bridges: Map<string, { server: Server; transport: StreamableHTTPServerTransport }>;
  aliases: Map<string, { recordId: string; name: string; kind: 'tool' | 'prompt' }>;
  closed: boolean;
  blocked: Set<string>;
  inventoryGeneration: number;
  inventoryReceipt?: string;
  authorizeTool?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
  refreshInventory?: (expected: Tool[]) => Promise<void>;
}
type SessionInput = Pick<ManagedMcpSession, 'sessionId' | 'workspaceId' | 'directory' | 'generation' | 'backend'>;

export class ManagedMcpGateway extends EventEmitter {
  private sessions = new Map<string, ManagedMcpSession>();
  authProvider?: (record: ManagedMcpRecord) => OAuthClientProvider;

  constructor(readonly config: McpConfigService) { super(); }

  contexts(): ManagedMcpSession[] { return [...this.sessions.values()]; }
  ownsApproval(id: string): boolean { return Boolean(this.sessions.get(id)?.authorizeTool); }
  displayName(id: string, name: string): string | undefined {
    const prefix = `mcp__${MANAGED_MCP_SERVER_KEY}__`;
    const session = this.sessions.get(id);
    const alias = name.startsWith(prefix) ? session?.aliases.get(name.slice(prefix.length)) : undefined;
    const record = alias ? session?.records.get(alias.recordId) : undefined;
    return record && alias ? this.sanitize(record, `${record.name} / ${alias.name}`) : undefined;
  }
  context(id: string): ManagedMcpSession {
    const session = this.sessions.get(id);
    if (!session || session.closed) throw new McpError(ErrorCode.InvalidRequest, 'MCP session is closed');
    return session;
  }

  async register(input: SessionInput): Promise<ManagedMcpSession> {
    const old = this.sessions.get(input.sessionId);
    if (old?.generation === input.generation) return old;
    if (old) await this.close(input.sessionId);
    const records = await this.config.effective(input.workspaceId);
    const context: ManagedMcpSession = { ...input, records: new Map(records.map(record => [record.id, record])),
      clients: new Map(), leases: new Map(), fences: new Map(), statuses: new Map(), bridges: new Map(), aliases: new Map(), blocked: new Set(), inventoryGeneration: 0, closed: false };
    this.sessions.set(input.sessionId, context);
    return context;
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(id);
    this.emit('closed', id);
    await Promise.allSettled([...session.bridges.values()].map(bridge => bridge.server.close()));
    await Promise.allSettled([...session.clients.values()].map(async client => (await client).close()));
  }

  private alias(session: ManagedMcpSession, record: ManagedMcpRecord, name: string, kind: 'tool' | 'prompt'): string {
    const alias = `${kind === 'tool' ? 't' : 'p'}_${createHash('sha256').update(`${record.id}\0${kind}\0${name}`).digest('hex').slice(0, 26)}`;
    const old = session.aliases.get(alias);
    if (old && (old.recordId !== record.id || old.name !== name || old.kind !== kind)) {
      throw new McpError(ErrorCode.InternalError, 'MCP name collision');
    }
    session.aliases.set(alias, { recordId: record.id, name, kind });
    return alias;
  }

  async client(session: ManagedMcpSession, record: ManagedMcpRecord): Promise<ManagedMcpClient> {
    const key = `${record.id}:${record.revision}:${record.oauthState?.obtainedAt ?? 0}`;
    let pending = session.clients.get(key);
    if (!pending) {
      session.statuses.set(record.id, { state: 'connecting' });
      pending = connectManagedMcp(record, session.directory,
        record.connection?.type !== 'stdio' && record.connection?.oauth ? this.authProvider?.(record) : undefined,
      ).then(connected => {
        connected.client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.notify(session));
        connected.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.notify(session));
        connected.client.setNotificationHandler(PromptListChangedNotificationSchema, () => this.notify(session));
        session.statuses.set(record.id, { state: 'connected' });
        this.emit('status', session.sessionId);
        return connected;
      }).catch(error => {
        session.clients.delete(key);
        session.statuses.set(record.id, { state: 'failed', error: managedMcpError(error) });
        this.emit('status', session.sessionId);
        throw error;
      });
      session.clients.set(key, pending);
    }
    return pending;
  }

  async notify(session: ManagedMcpSession): Promise<void> {
    session.inventoryGeneration++;
    session.inventoryReceipt = undefined;
    await Promise.allSettled([...session.bridges.values()].flatMap(({ server }) => [
      server.sendToolListChanged(), server.sendResourceListChanged(), server.sendPromptListChanged(),
    ]));
  }

  private inventoryDigest(tools: Tool[]): string {
    return createHash('sha256').update(JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest('hex');
  }
  async confirmInventory(id: string, expected: Tool[]): Promise<void> {
    const wanted = this.inventoryDigest(expected);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const session = this.context(id);
      if (session.inventoryReceipt === wanted) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Backend tool inventory has not updated');
  }

  async listTools(id: string): Promise<Tool[]> {
    const session = this.context(id);
    const batches = await Promise.all([...session.records.values()].map(async record => {
      try {
        const { client } = await this.client(session, record);
        if (!client.getServerCapabilities()?.tools) return [];
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools({ cursor });
          tools.push(...page.tools.map(tool => ({ ...this.sanitize(record, tool),
            name: this.alias(session, record, tool.name, 'tool'),
            description: this.sanitize(record, `${record.name} / ${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
            _meta: this.sanitize(record, { ...tool._meta, 'comate/source': { server: record.name, tool: tool.name } }),
          })));
          cursor = page.nextCursor;
        } while (cursor);
        const status = session.statuses.get(record.id);
        if (status) status.tools = tools.map(tool => ({ name: tool.name, description: tool.description }));
        return tools;
      } catch {
        session.statuses.set(record.id, { state: 'failed', error: 'Unable to discover MCP tools. Check the service connection.' });
        this.emit('status', session.sessionId);
        return [];
      }
    }));
    return batches.flat();
  }

  private resourceUri(recordId: string, uri: string): string {
    return `managed-mcp://${recordId}/${encodeURIComponent(uri).replace(/%7B/gi, '{').replace(/%7D/gi, '}')}`;
  }

  private sanitize<T>(record: ManagedMcpRecord, value: T): T {
    const current = this.config.store.mcp.get(record.id);
    return sanitizeMcpValue(record, current ? sanitizeMcpValue(current, value) : value);
  }

  private resourceReferences<T>(recordId: string, value: T): T {
    if (!value || typeof value !== 'object') return value;
    const block = (input: unknown): unknown => {
      if (!input || typeof input !== 'object') return input;
      const content = input as Record<string, unknown>;
      if (content.type === 'resource_link' && typeof content.uri === 'string') return { ...content, uri: this.resourceUri(recordId, content.uri) };
      if (content.type === 'resource' && content.resource && typeof content.resource === 'object') {
        const resource = content.resource as Record<string, unknown>;
        if (typeof resource.uri === 'string') return { ...content, resource: { ...resource, uri: this.resourceUri(recordId, resource.uri) } };
      }
      return input;
    };
    const result = value as Record<string, unknown>;
    return { ...result,
      ...(Array.isArray(result.content) ? { content: result.content.map(block) } : {}),
      ...(Array.isArray(result.messages) ? { messages: result.messages.map(message => ({ ...message, content: block(message.content) })) } : {}),
    } as T;
  }

  private async leased<T>(session: ManagedMcpSession, recordId: string, fn: (connected: ManagedMcpClient, record: ManagedMcpRecord) => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (session.fences.has(recordId) && !session.closed) {
      const fence = session.fences.get(recordId)!;
      if (!signal) { await fence; continue; }
      let onAbort!: () => void;
      try {
        await Promise.race([fence, new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new McpError(ErrorCode.InvalidRequest, 'MCP operation was cancelled.'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
      } finally { signal.removeEventListener('abort', onAbort); }
    }
    if (session.closed) throw new McpError(ErrorCode.InvalidRequest, 'MCP session is closed');
    const record = session.records.get(recordId);
    if (!record) throw new McpError(ErrorCode.InvalidParams, 'MCP service is no longer available');
    if (session.blocked.has(recordId)) throw new McpError(ErrorCode.InvalidRequest, 'MCP configuration is not applied. Retry from MCP settings.');
    session.leases.set(recordId, (session.leases.get(recordId) ?? 0) + 1);
    try { return this.sanitize(record, this.resourceReferences(recordId, await fn(await this.client(session, record), record))); }
    catch { throw new McpError(ErrorCode.InternalError, 'MCP operation failed. Check the service connection and authentication.'); }
    finally {
      session.leases.set(recordId, (session.leases.get(recordId) ?? 1) - 1);
      this.emit('drained', session.sessionId);
    }
  }

  async callTool(id: string, name: string, args?: Record<string, unknown>, signal?: AbortSignal,
    onprogress?: (progress: { progress: number; total?: number; message?: string }) => void) {
    const session = this.context(id);
    const target = session.aliases.get(name);
    if (!target || target.kind !== 'tool') throw new McpError(ErrorCode.InvalidParams, 'MCP tool is unavailable. Refresh the tool list.');
    if (!session.authorizeTool) throw new McpError(ErrorCode.InvalidRequest, 'MCP session permission gate is unavailable');
    const revision = session.records.get(target.recordId)?.revision;
    const approved = await session.authorizeTool(`mcp__${MANAGED_MCP_SERVER_KEY}__${name}`, args ?? {}, signal ?? new AbortController().signal);
    return this.leased(session, target.recordId, ({ client }, record) => {
      if (record.revision !== revision || signal?.aborted) throw new Error('MCP call changed before dispatch');
      return client.callTool({ name: target.name, arguments: approved }, undefined, { signal, timeout: 300_000, onprogress });
    }, signal);
  }

  private async listPrompts(session: ManagedMcpSession): Promise<Prompt[]> {
    const batches = await Promise.all([...session.records.values()].map(async record => {
      try {
        const { client } = await this.client(session, record);
        if (!client.getServerCapabilities()?.prompts) return [];
        const prompts: Prompt[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listPrompts({ cursor });
          prompts.push(...page.prompts.map(prompt => ({ ...this.sanitize(record, prompt), name: this.alias(session, record, prompt.name, 'prompt'),
            description: this.sanitize(record, `${record.name} / ${prompt.name}${prompt.description ? `: ${prompt.description}` : ''}`) })));
          cursor = page.nextCursor;
        } while (cursor);
        return prompts;
      } catch { return []; }
    }));
    return batches.flat();
  }

  private async listResources(session: ManagedMcpSession, templates: boolean): Promise<Resource[] | ResourceTemplate[]> {
    const batches = await Promise.all([...session.records.values()].map(async record => {
      try {
        const { client } = await this.client(session, record);
        if (!client.getServerCapabilities()?.resources) return [];
        const entries: Array<Resource | ResourceTemplate> = [];
        let cursor: string | undefined;
        do {
          if (templates) {
            const page = await client.listResourceTemplates({ cursor });
            entries.push(...page.resourceTemplates.map(entry => this.sanitize(record, { ...entry, uriTemplate: this.resourceUri(record.id, entry.uriTemplate) })));
            cursor = page.nextCursor;
          } else {
            const page = await client.listResources({ cursor });
            entries.push(...page.resources.map(entry => this.sanitize(record, { ...entry, uri: this.resourceUri(record.id, entry.uri) })));
            cursor = page.nextCursor;
          }
        } while (cursor);
        return entries;
      } catch { return []; }
    }));
    return batches.flat() as Resource[] | ResourceTemplate[];
  }

  private buildServer(session: ManagedMcpSession): Server {
    const server = new Server({ name: MANAGED_MCP_SERVER_KEY, version: '1.0.0' }, {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
      instructions: 'Tools are provided by user-configured MCP services. Tool descriptions identify their original service and name.',
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const generation = session.inventoryGeneration;
      if (session.backend === 'codex') return { tools: CODEX_TOOLS };
      const tools = await this.listTools(session.sessionId);
      if (generation === session.inventoryGeneration) session.inventoryReceipt = this.inventoryDigest(tools);
      this.emit('inventory', session.sessionId);
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      let name = request.params.name, args = request.params.arguments;
      if (session.backend === 'codex') {
        if (name === MANAGED_MCP_DISCOVER) {
          const tools = await this.listTools(session.sessionId);
          const catalog = { tools, revision: this.inventoryDigest(tools) };
          return { content: [{ type: 'text', text: JSON.stringify(catalog) }], structuredContent: catalog };
        }
        if (name !== MANAGED_MCP_INVOKE || typeof args?.tool !== 'string' ||
            !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
          throw new McpError(ErrorCode.InvalidParams, 'Use discover and invoke with a current tool ID and arguments');
        }
        name = args.tool; args = args.arguments as Record<string, unknown>;
      }
      return this.callTool(session.sessionId, name,
      args, extra.signal, request.params._meta?.progressToken === undefined ? undefined : progress => {
        void extra.sendNotification({ method: 'notifications/progress', params: {
          ...progress, progressToken: request.params._meta!.progressToken!,
        } }).catch(() => undefined);
      });
    });
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await this.listPrompts(session) }));
    server.setRequestHandler(GetPromptRequestSchema, async request => {
      const target = session.aliases.get(request.params.name);
      if (!target || target.kind !== 'prompt') throw new McpError(ErrorCode.InvalidParams, 'MCP prompt is unavailable');
      return this.leased(session, target.recordId, ({ client }) => client.getPrompt({ ...request.params, name: target.name }));
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await this.listResources(session, false) as Resource[] }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: await this.listResources(session, true) as ResourceTemplate[] }));
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
      const uri = new URL(request.params.uri);
      if (uri.protocol !== 'managed-mcp:') throw new McpError(ErrorCode.InvalidParams, 'Invalid managed resource URI');
      return this.leased(session, uri.hostname, async ({ client }, record) => {
        const response = await client.readResource({ uri: decodeURIComponent(uri.pathname.slice(1)) });
        return { ...response, contents: response.contents.map(content => ({ ...content, uri: this.resourceUri(record.id, content.uri) })) };
      });
    });
    return server;
  }

  router(authorize: (token: string, sessionId: string, generation: string) => boolean): Router {
    const router = Router();
    router.use(json({ limit: '10mb' }));
    router.all('/:sessionId', async (req, res) => {
      const session = this.sessions.get(req.params.sessionId);
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host) { res.status(403).end(); return; }
        } catch { res.status(403).end(); return; }
      }
      if (!token || !session || !authorize(token, session.sessionId, session.generation)) {
        res.status(401).json({ error: 'Unauthorized MCP session' });
        return;
      }
      const protocolId = req.headers['mcp-session-id'];
      let bridge = typeof protocolId === 'string' ? session.bridges.get(protocolId) : undefined;
      if (!bridge && req.method === 'POST' && !protocolId && isInitializeRequest(req.body)) {
        const server = this.buildServer(session);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => { session.bridges.set(id, { server, transport }); },
        });
        transport.onclose = () => {
          if (transport.sessionId) session.bridges.delete(transport.sessionId);
        };
        await server.connect(transport);
        bridge = { server, transport };
      }
      if (!bridge) { res.status(404).json({ error: 'MCP protocol session not found' }); return; }
      try { await bridge.transport.handleRequest(req, res, req.body); }
      catch {
        if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
      }
    });
    return router;
  }
}

export const managedMcpGateway = new ManagedMcpGateway(mcpConfigService);
