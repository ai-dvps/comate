/**
 * OpencodeBackendDriver — the opencode agent runtime behind the session
 * core's BackendDriver seam (KTD-1, U4).
 *
 * Shape: createStreamingQuery is synchronous per the seam; all async setup
 * (ensure the per-workspace serve, create/reattach the remote session,
 * subscribe SSE with auth + directory scope) happens lazily inside the
 * messages generator on first pull. The generator yields SDKMessage-shaped
 * events produced by opencode-event-mapper; permission.asked and
 * question.asked are intercepted before mapping and bridged into the core's
 * unified canUseTool callback, with replies translated back (allow →
 * once/always, deny → reject, question answers → /question/{id}/reply).
 *
 * The query handle covers the surface the core uses: interrupt (REST abort),
 * getContextUsage (best-effort from tracked message token info), stopTask
 * (no opencode background-task control surface — logged no-op), close.
 */

import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { BackendDriver } from './backend-driver.js';
import type { EffectiveProviderConfiguration } from './provider-resolver.js';
import { BROWSER_MCP_SERVER_KEY } from './browser-mcp.js';
import { getSidecarBaseUrl } from '../utils/self-port.js';
import { buildBrowserMcpClientConnection } from './browser-mcp-client-config.js';
import {
  opencodeFetch,
  opencodeServerManager,
  type OpencodeServerInstance,
} from './opencode-server-manager.js';
import {
  createOpencodeMapperState,
  mapOpencodeEvent,
  mapToolName,
  type OpencodeEventEnvelope,
  type OpencodeMapperState,
} from './opencode-event-mapper.js';
import { SseParser } from './opencode-client.js';
import { PushableIterator } from './pushable-iterator.js';
import { diagLog } from '../utils/diag-logger.js';
import {
  decideModelFallback,
  expandModelAliases,
  isModelNotFoundError,
  stripModelSuffix,
} from './opencode-model-fallback.js';
import type { PermissionSuggestion } from '../types/message.js';

export interface OpencodeAdapterDeps {
  /** Workspace folder — the serve process's cwd and session directory scope. */
  directory: string;
  comateSessionId: string;
  /** Remote opencode session id for resume; created and persisted on first run. */
  backendSessionId?: string;
  provider: Extract<EffectiveProviderConfiguration, { available: true }>;
  providerName: string;
  /** Ambient session env (already computed for the SDK path; sanitized again). */
  env: NodeJS.ProcessEnv;
  /** Called with the remote session id after creation so it can be persisted. */
  onBackendSessionId?: (backendSessionId: string) => void;
  /** Mirrors OpenCode's asynchronously generated title back into Comate. */
  onSessionTitle?: (title: string) => void;
}




const PERMISSION_ASKED_EVENTS = new Set(['permission.asked', 'permission.updated']);
const QUESTION_ASKED_EVENTS = new Set(['question.asked']);

/** Anthropic-compatible providers in Comate follow the claude convention of
 * a base URL without the API version; the ai-sdk anthropic client appends
 * `/messages` only, so the version segment must live in the configured base. */
function toAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function isOpencodeDefaultTitle(title: string): boolean {
  return /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title);
}

function openCodeModelMetadata(
  provider: Extract<EffectiveProviderConfiguration, { available: true }>,
): Record<string, unknown> {
  const profile = provider.openCodeModelProfile;
  if (!profile) return {};
  const variants = profile.variants && Object.fromEntries(Object.entries(profile.variants).map(([name, variant]) => [
    name,
    provider.mode === 'direct-anthropic'
      ? { thinking: { type: 'enabled', budgetTokens: variant.thinkingBudgetTokens } }
      : {
          ...(variant.reasoningEffort !== undefined && { reasoningEffort: variant.reasoningEffort }),
          ...(variant.reasoningSummary !== undefined && { reasoningSummary: variant.reasoningSummary }),
        },
  ]));
  return {
    ...(profile.reasoning !== undefined && { reasoning: profile.reasoning }),
    ...(profile.toolCall !== undefined && { tool_call: profile.toolCall }),
    ...(profile.contextWindow !== undefined && profile.maxOutputTokens !== undefined && {
      limit: { context: profile.contextWindow, output: profile.maxOutputTokens },
    }),
    ...(profile.inputModalities !== undefined && profile.outputModalities !== undefined && {
      modalities: { input: profile.inputModalities, output: profile.outputModalities },
    }),
    ...(profile.reasoningField !== undefined && { interleaved: { field: profile.reasoningField } }),
    ...(variants && Object.keys(variants).length > 0 && { variants }),
  };
}

export function buildServeConfig(
  provider: Extract<EffectiveProviderConfiguration, { available: true }>,
  providerName: string,
): Record<string, unknown> {
  if (provider.agent !== 'opencode') throw new Error('OpenCode requires an OpenCode provider resolution');
  if (provider.mode !== 'direct-anthropic' && provider.mode !== 'direct-openai-chat') {
    throw new Error(`OpenCode provider mode '${provider.mode}' is unavailable`);
  }
  const anthropic = provider.mode === 'direct-anthropic';
  return {
    permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', question: 'allow' },
    provider: {
      [`comate-${provider.providerId}`]: {
        npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        name: providerName,
        options: {
          baseURL: anthropic ? toAnthropicBaseUrl(provider.baseUrl) : provider.baseUrl.replace(/\/+$/, ''),
          apiKey: provider.credential,
        },
        models: expandModelAliases(provider.model, openCodeModelMetadata(provider)),
      },
    },
  };
}

/** Per-session serve additions that depend on the Comate session id (the
 * browser MCP binds to the session's embedded browser via its URL, KTD-6). */
function buildSessionMcpConfig(comateSessionId: string, taskToken: string): Record<string, unknown> {
  return {
    [BROWSER_MCP_SERVER_KEY]: {
      type: 'remote',
      ...buildBrowserMcpClientConnection(getSidecarBaseUrl(), comateSessionId, taskToken),
      oauth: false,
    },
  };
}

type OpencodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string };

const IMAGE_FILENAME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function safeImageFilename(value: unknown, mediaType: string, index: number): string {
  const fallback = `image-${index}.${IMAGE_FILENAME_EXTENSIONS[mediaType] ?? 'bin'}`;
  if (typeof value !== 'string') return fallback;
  const leaf = value.split(/[\\/]/).pop()?.split('')
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join('').trim();
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, 255) : fallback;
}

function extractPromptParts(message: SDKUserMessage): OpencodePromptPart[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: OpencodePromptPart[] = [];
  let imageIndex = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as {
      type?: string;
      text?: unknown;
      name?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    };
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (
      block.type !== 'image'
      || block.source?.type !== 'base64'
      || typeof block.source.media_type !== 'string'
      || typeof block.source.data !== 'string'
      || !block.source.data
    ) continue;

    imageIndex += 1;
    const mediaType = block.source.media_type;
    parts.push({
      type: 'file',
      mime: mediaType,
      filename: safeImageFilename(block.name, mediaType, imageIndex),
      url: `data:${mediaType};base64,${block.source.data}`,
    });
  }
  return parts;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeComateMessageId(clientTurnId: string): string | undefined {
  return UUID_RE.test(clientTurnId)
    ? `msg_comate_${clientTurnId.replace(/-/g, '').toLowerCase()}`
    : undefined;
}

function extractTextOnlySlashCommand(
  parts: readonly OpencodePromptPart[],
): { name: string; args: string } | undefined {
  if (parts.length !== 1 || parts[0].type !== 'text') return undefined;
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(parts[0].text.trim());
  return slash ? { name: slash[1], args: slash[2] ?? '' } : undefined;
}

/** Unit-test surface for the adapter's pure translation helpers. */
export const __testables = {
  buildServeConfig,
  buildSessionMcpConfig,
  toAnthropicBaseUrl,
  extractPromptParts,
  encodeComateMessageId,
  extractTextOnlySlashCommand,
  isOpencodeDefaultTitle,
};

export class OpencodeBackendDriver implements BackendDriver {
  readonly backendId = 'opencode' as const;

  private instance?: OpencodeServerInstance;
  private backendSessionId?: string;
  private modelID: string;
  private providerID: string;
  private mapperState: OpencodeMapperState = createOpencodeMapperState();
  private toolRegistry = new Map<string, { tool: string; input: unknown }>();
  private abort = new AbortController();
  private promptQueue: Promise<void> = Promise.resolve();
  private pendingAdmissions = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  private closed = false;

  constructor(private readonly deps: OpencodeAdapterDeps) {
    this.backendSessionId = deps.backendSessionId;
    this.providerID = `comate-${deps.provider.providerId}`;
    // Strip claude-code alias suffixes (e.g. `glm-5.2[1m]`) before they reach
    // the opencode backend, which does not accept them as model ids.
    this.modelID = stripModelSuffix(deps.provider.model);
  }

  prepareAdmission(clientTurnId: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('OpenCode session is closed'));
    if (this.pendingAdmissions.has(clientTurnId)) {
      return Promise.reject(new Error(`OpenCode turn ${clientTurnId} is already pending admission`));
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingAdmissions.set(clientTurnId, { resolve, reject });
    });
  }

  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> } {
    const query = {
      interrupt: async () => {
        if (!this.instance || !this.backendSessionId) return;
        const response = await opencodeFetch(this.instance, `/session/${this.backendSessionId}/abort`, {
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(`OpenCode abort failed with HTTP ${response.status}`);
        }
        if (await response.json() !== true) {
          throw new Error('OpenCode did not acknowledge the abort');
        }
        return { still_queued: [] };
      },
      close: () => {
        this.closed = true;
        this.abort.abort();
        this.lastPrompt = undefined;
        this.rejectPendingAdmissions(new Error('OpenCode session closed before prompt admission'));
        // Per-session serve lifecycle maps 1:1 onto the runtime (KTD-6).
        void opencodeServerManager.stopServer(this.deps.comateSessionId);
      },
      getContextUsage: async () => {
        const usage = this.mapperState.lastUsage;
        const totalTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
        const maxTokens = this.deps.provider.openCodeModelProfile?.contextWindow ?? 0;
        return {
          totalTokens,
          maxTokens,
          percentage: maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0,
          categories: [
            { name: 'input', tokens: usage?.input ?? 0 },
            { name: 'output', tokens: usage?.output ?? 0 },
          ],
        };
      },
      stopTask: async (taskId: string) => {
        // opencode has no background-task control surface in its REST API;
        // the core reconciles tracked tasks on loop end regardless.
        diagLog(`[OpencodeBackendDriver] stopTask(${taskId}) unmapped — no-op`);
        return undefined;
      },
      setModel: async (model: string) => {
        this.modelID = stripModelSuffix(model);
        return undefined;
      },
    } as unknown as Query;

    return { query, messages: this.run(input, options) };
  }

  private async *run(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): AsyncGenerator<SDKMessage> {
    try {
      await this.init(options);
      this.consumeInput(input, options);
      yield* this.streamEvents();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.rejectPendingAdmissions(err);
      diagLog(`[OpencodeBackendDriver] run error: ${message}`);
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        session_id: this.deps.comateSessionId,
        errors: [`opencode backend error: ${message}`],
      } as unknown as SDKMessage;
    }
  }

  private async init(options: Options): Promise<void> {
    const browserEnabled = Boolean(options.mcpServers?.[BROWSER_MCP_SERVER_KEY]);
    const browserServer = options.mcpServers?.[BROWSER_MCP_SERVER_KEY] as { headers?: Record<string, string> } | undefined;
    const authorization = browserServer?.headers?.Authorization;
    const taskToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (browserEnabled && !taskToken) {
      throw new Error('OpenCode runtime is missing its browser MCP bearer');
    }
    this.instance = await opencodeServerManager.ensureServer(
      this.deps.comateSessionId,
      this.deps.directory,
      {
        config: {
          ...buildServeConfig({ ...this.deps.provider, model: this.modelID }, this.deps.providerName),
          mcp: browserEnabled
            ? buildSessionMcpConfig(this.deps.comateSessionId, taskToken!)
            : {},
        },
        env: this.deps.env,
      },
    );

    if (!this.backendSessionId) {
      const created = (await (
        await opencodeFetch(this.instance, '/session', {
          method: 'POST',
          // Let OpenCode assign its recognized default title. Its first-prompt
          // title agent only runs while the session still has that default.
          body: JSON.stringify({}),
        })
      ).json()) as { id: string };
      this.backendSessionId = created.id;
      this.deps.onBackendSessionId?.(created.id);
      diagLog(`[OpencodeBackendDriver] created remote session ${created.id} for ${this.deps.comateSessionId}`);
    } else {
      diagLog(`[OpencodeBackendDriver] reattaching remote session ${this.backendSessionId} for ${this.deps.comateSessionId}`);
    }

    void this.refreshCommands();
    this.startEventSubscription(options);
  }

  private knownCommands = new Set<string>();

  private async refreshCommands(): Promise<void> {
    try {
      this.knownCommands = new Set((await this.listBackendCommands()).map((c) => c.name));
    } catch {
      // Command discovery is best-effort; slash execution falls back to prompts.
    }
  }

  /** Route permission/question events to the core; everything else to the mapper queue. */
  private readonly eventStream = new PushableIterator<SDKMessage | null>();

  private pushEvent(event: SDKMessage | null): void {
    this.eventStream.push(event);
  }

  private startEventSubscription(options: Options): void {
    const instance = this.instance!;
    const sessionId = this.backendSessionId!;
    const eventPath = `/event?directory=${encodeURIComponent(this.deps.directory)}`;

    void (async () => {
      const res = await fetch(`${instance.baseUrl}${eventPath}`, {
        signal: this.abort.signal,
        headers: { accept: 'text/event-stream', ...instance.authHeaders },
      });
      if (!res.ok || !res.body) {
        throw new Error(`opencode GET /event → ${res.status}`);
      }
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
          this.routeEvent(event as OpencodeEventEnvelope, options, sessionId);
        }
      }
    })()
      .catch((err: unknown) => {
        if (this.closed) return;
        diagLog(`[OpencodeBackendDriver] event stream error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!this.closed && this.mapperState.pendingContextOverflow) {
          // A dropped event stream must not strand the client in a permanent
          // compacting state. Treat the unfinished recovery as terminal before
          // closing the iterator so the original overflow remains visible.
          this.routeEvent(
            { type: 'session.idle', properties: { sessionID: sessionId } },
            options,
            sessionId,
          );
        }
        this.pushEvent(null);
      });
  }

  private routeEvent(
    event: OpencodeEventEnvelope,
    options: Options,
    sessionId: string,
  ): void {
    const properties = event.properties ?? {};

    if (event.type === 'message.part.updated') {
      const part = properties.part as { callID?: string; tool?: string; state?: { input?: unknown } } | undefined;
      if (part?.callID && part.tool) {
        this.toolRegistry.set(part.callID, {
          tool: part.tool,
          input: part.state?.input ?? {},
        });
      }
    }

    const eventSessionId = String(properties.sessionID ?? '');
    if (eventSessionId && eventSessionId !== sessionId) return;

    if (event.type === 'session.updated') {
      const info = properties.info as { id?: string; title?: string } | undefined;
      if ((!info?.id || info.id === sessionId) && typeof info?.title === 'string' && info.title.trim()) {
        const title = info.title.trim();
        if (!isOpencodeDefaultTitle(title)) {
          try {
            this.deps.onSessionTitle?.(title);
          } catch (err) {
            // Title mirroring is best-effort metadata. Never let a storage or
            // observer failure tear down the agent's event subscription.
            diagLog(`[OpencodeBackendDriver] session title observer failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    if (event.type === 'session.idle' || event.type === 'session.error') {
      diagLog(`[OpencodeBackendDriver] ${event.type} session=${eventSessionId || '(none)'} ${JSON.stringify(properties).slice(0, 200)}`);
    }

    if (PERMISSION_ASKED_EVENTS.has(event.type)) {
      void this.bridgePermission(properties, options);
      return;
    }
    if (QUESTION_ASKED_EVENTS.has(event.type)) {
      void this.bridgeQuestion(properties, options);
      return;
    }

    // Transparent claude-code alias compatibility: a model-not-found error
    // on a `[...]`-suffixed model id is retried once with the base id, so a
    // provider configured for claude works on opencode without user changes.
    if (event.type === 'session.error' && this.handleModelFallback(properties, options)) {
      return;
    }

    if (event.type === 'session.error' || (event.type === 'session.idle' && !this.mapperState.erroredTurn)) {
      this.lastPrompt = undefined;
    }

    for (const message of mapOpencodeEvent(event, this.mapperState)) {
      this.pushEvent(message);
    }
  }

  /** Returns true when the error was swallowed for a transparent retry. */
  private handleModelFallback(
    properties: Record<string, unknown>,
    options: Options,
  ): boolean {
    const error = (properties.error ?? {}) as { data?: { message?: string }; message?: string };
    const message = error.data?.message ?? error.message ?? '';
    if (!isModelNotFoundError(message)) return false;

    const decision = decideModelFallback(message, this.modelID, this.wireModelResolved);
    if (decision.action !== 'retry' || !decision.wireModelID) return false;

    diagLog(
      `[OpencodeBackendDriver] model '${this.modelID}' rejected as not found; ` +
        `retrying transparently with base id '${decision.wireModelID}'`,
    );
    this.modelID = decision.wireModelID;
    this.wireModelResolved = true;
    // Suppress the errored turn's idle as well as the error itself: emitting
    // a success result now would tell waiters the turn completed while the
    // retry is still in flight (they can then close/abort and kill the retry).
    this.mapperState.erroredTurn = true;
    if (this.lastPrompt) {
      void this.sendPrompt(this.lastPrompt.parts, options, this.lastPrompt.messageID).catch((err) => {
        this.lastPrompt = undefined;
        diagLog(`[OpencodeBackendDriver] fallback prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return true;
  }

  private wireModelResolved = false;
  private lastPrompt?: { parts: OpencodePromptPart[]; messageID?: string };

  private rejectPendingAdmissions(error: unknown): void {
    for (const admission of this.pendingAdmissions.values()) admission.reject(error);
    this.pendingAdmissions.clear();
  }

  private async bridgePermission(
    properties: Record<string, unknown>,
    options: Options,
  ): Promise<void> {
    const requestId = String(properties.id ?? '');
    const ocSessionId = String(properties.sessionID ?? this.backendSessionId);
    const toolRef = properties.tool as { callID?: string } | undefined;
    const callId = toolRef?.callID;
    const registered = callId ? this.toolRegistry.get(callId) : undefined;
    const toolName = registered?.tool
      ? mapToolName(registered.tool)
      : mapToolName(String(properties.permission ?? 'unknown'));
    const input = registered?.input ?? (properties.metadata ?? {});

    const patterns = [
      ...((properties.always as string[] | undefined) ?? []),
      ...((properties.patterns as string[] | undefined) ?? []),
    ];
    const suggestions: PermissionSuggestion[] | undefined = patterns.length
      ? [
          {
            type: 'addRules',
            rules: patterns.map((ruleContent) => ({ toolName, ruleContent })),
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : undefined;

    let result: PermissionResult | null = null;
    try {
      result = await options.canUseTool!(toolName, input as Record<string, unknown>, {
        signal: this.abort.signal,
        suggestions,
        toolUseID: callId ?? requestId,
        requestId,
        title: typeof properties.title === 'string' ? properties.title : undefined,
      });
    } catch (err) {
      diagLog(`[OpencodeBackendDriver] canUseTool threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const response = this.toPermissionReply(result);
    if (!this.instance) return;
    const reply = await opencodeFetch(this.instance, `/session/${ocSessionId}/permissions/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }).catch((err) => {
      diagLog(`[OpencodeBackendDriver] permission reply failed: ${err}`);
      return undefined;
    });
    diagLog(
      `[OpencodeBackendDriver] permission ${requestId} → "${response}" (status=${reply?.status ?? 'request failed'})`,
    );
  }

  private toPermissionReply(result: PermissionResult | null): 'once' | 'always' | 'reject' {
    if (!result || result.behavior === 'deny') return 'reject';
    const suggestions =
      (result as { updatedPermissions?: PermissionSuggestion[] }).updatedPermissions ?? [];
    return suggestions.length > 0 ? 'always' : 'once';
  }

  private async bridgeQuestion(
    properties: Record<string, unknown>,
    options: Options,
  ): Promise<void> {
    const requestId = String(properties.id ?? '');
    const questions = ((properties.questions as Array<Record<string, unknown>> | undefined) ?? []).map(
      (q) => ({
        question: String(q.question ?? ''),
        header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options)
          ? (q.options as Array<Record<string, unknown>>).map((o) => ({
              label: String(o.label ?? ''),
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
          : [],
        multiSelect: q.multiple === true || q.multiSelect === true,
      }),
    );

    let result: PermissionResult | null = null;
    try {
      result = await options.canUseTool!('AskUserQuestion', { questions }, {
        signal: this.abort.signal,
        toolUseID: requestId,
        requestId,
      });
    } catch (err) {
      diagLog(`[OpencodeBackendDriver] question canUseTool threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const updatedInput = (result as { updatedInput?: { answers?: Record<string, string> } } | null)
      ?.updatedInput;
    const answers = questions.map((q) => {
      const raw = updatedInput?.answers?.[q.question] ?? '';
      // opencode expects an array of selected labels per question.
      return q.multiSelect && raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw];
    });

    if (!this.instance) return;
    await opencodeFetch(this.instance, `/question/${requestId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }).catch((err) => {
      diagLog(`[OpencodeBackendDriver] question reply failed: ${err}`);
    });
  }

  private async *streamEvents(): AsyncGenerator<SDKMessage> {
    for await (const event of this.eventStream) {
      if (event === null) return;
      yield event;
    }
  }

  private consumeInput(input: AsyncIterable<SDKUserMessage>, options: Options): void {
    void (async () => {
      for await (const message of input) {
        if (this.closed) return;
        const parts = extractPromptParts(message);
        if (parts.length === 0) continue;
        const clientTurnId = message.uuid;
        const messageID = typeof clientTurnId === 'string'
          ? encodeComateMessageId(clientTurnId)
          : undefined;
        const admission = typeof clientTurnId === 'string'
          ? this.pendingAdmissions.get(clientTurnId)
          : undefined;
        this.promptQueue = this.promptQueue
          .catch(() => {})
          .then(() => this.sendPrompt(parts, options, messageID));
        await this.promptQueue.then(
          () => admission?.resolve(),
          (err) => {
            this.lastPrompt = undefined;
            admission?.reject(err);
            diagLog(`[OpencodeBackendDriver] prompt failed: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
        if (typeof clientTurnId === 'string') this.pendingAdmissions.delete(clientTurnId);
      }
    })().catch((err) => {
      diagLog(`[OpencodeBackendDriver] input consumption error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async sendPrompt(
    parts: OpencodePromptPart[],
    options: Options,
    messageID?: string,
  ): Promise<void> {
    if (!this.instance || !this.backendSessionId) {
      throw new Error('OpenCode session is not ready for prompt admission');
    }
    this.lastPrompt = { parts, ...(messageID ? { messageID } : {}) };

    // Slash commands execute via opencode's command endpoint (server-side
    // template expansion) only for text-only command turns. Mixed/image turns
    // must stay on prompt_async so their file parts are not discarded.
    const slash = extractTextOnlySlashCommand(parts);
    if (slash && this.knownCommands.has(slash.name)) {
      const executed = await this.executeBackendCommand(slash.name, slash.args);
      if (executed) return;
      diagLog(`[OpencodeBackendDriver] /command ${slash.name} failed; falling back to prompt`);
    }

    const system =
      typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined;
    const response = await opencodeFetch(this.instance, `/session/${this.backendSessionId}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({
        parts,
        ...(messageID ? { messageID } : {}),
        ...(this.modelID ? { model: { providerID: this.providerID, modelID: this.modelID } } : {}),
        ...(system ? { system } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenCode prompt admission failed with HTTP ${response.status}`);
    }
  }

  /** Session operations parity (R8): fork creates a sibling remote session. */
  async forkBackendSession(): Promise<string | undefined> {
    if (!this.instance || !this.backendSessionId) return undefined;
    const forked = (await (
      await opencodeFetch(this.instance, `/session/${this.backendSessionId}/fork`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
    ).json()) as { id?: string };
    return forked.id;
  }

  async listChildSessions(): Promise<string[]> {
    if (!this.instance || !this.backendSessionId) return [];
    const children = (await (
      await opencodeFetch(this.instance, `/session/${this.backendSessionId}/children`)
    ).json()) as Array<{ id: string }>;
    return children.map((c) => c.id);
  }

  /** Slash-command surface (U7): commands advertised by this session's serve. */
  async listBackendCommands(): Promise<Array<{ name: string; description?: string; template?: string }>> {
    if (!this.instance) return [];
    const res = await opencodeFetch(this.instance, '/command');
    if (!res.ok) return [];
    const commands = (await res.json()) as Array<{
      name: string;
      description?: string;
      template?: string;
    }>;
    return commands;
  }

  /** Execute a slash command via opencode's command endpoint (template expansion). */
  async executeBackendCommand(name: string, args: string): Promise<boolean> {
    if (!this.instance || !this.backendSessionId) return false;
    const res = await opencodeFetch(this.instance, `/session/${this.backendSessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: name, arguments: args }),
    });
    return res.ok;
  }
}
