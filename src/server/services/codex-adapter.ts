import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackendDriver, BackendToolRequestHandler } from './backend-driver.js';
import type { ProviderCodexModelProfile } from '../models/provider.js';
import {
  codexAppServerManager,
  type CodexAppServerManager,
  type CodexSkill,
} from './codex-app-server-manager.js';
import { CodexEventMapper } from './codex-event-mapper.js';
import { CodexRpcError } from './codex-rpc-client.js';

interface CodexAdapterDeps {
  directory: string;
  backendSessionId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  provider?: CodexProviderOverride;
  onBackendSessionId(id: string): void;
  onFatal?(error: unknown): void;
  manager?: CodexAppServerManager;
}

export interface CodexProviderOverride {
  name: string;
  baseUrl: string;
  bearerToken: string;
  /** Chat compatibility routes cannot represent Codex-hosted tools. */
  disableHostedTools?: boolean;
  modelProfile?: ProviderCodexModelProfile;
}

class AsyncMessageQueue {
  private values: SDKMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private ended = false;
  push(value: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  async *iterate(): AsyncGenerator<SDKMessage> {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) return;
      else {
        const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

export class CodexBackendDriver implements BackendDriver {
  readonly backendId = 'codex' as const;
  private readonly manager: CodexAppServerManager;
  private threadId?: string;
  private turnId?: string;
  private closed = false;
  private ended = false;
  private queue = new AsyncMessageQueue();
  private readonly mapper: CodexEventMapper;
  private toolRequestHandler?: BackendToolRequestHandler;
  private readonly pendingAdmissions = new Map<
    string,
    { resolve(): void; reject(error: unknown): void }
  >();
  private tokenUsage?: {
    total: {
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    };
    modelContextWindow: number | null;
  };

  constructor(private readonly deps: CodexAdapterDeps) {
    this.manager = deps.manager ?? codexAppServerManager;
    this.threadId = deps.backendSessionId;
    this.mapper = new CodexEventMapper(deps.model ?? 'codex');
  }

  prepareAdmission(clientTurnId: string): Promise<void> {
    if (this.closed || this.ended) return Promise.reject(new Error('Codex session is closed'));
    if (this.pendingAdmissions.has(clientTurnId)) {
      return Promise.reject(new Error(`Codex turn ${clientTurnId} is already pending admission`));
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingAdmissions.set(clientTurnId, { resolve, reject });
    });
  }

  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> } {
    void this.run(input, options);
    const query = {
      interrupt: async () => {
        if (this.threadId && this.turnId) {
          await this.manager.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
        }
      },
      close: () => {
        this.closed = true;
        this.rejectPendingAdmissions(new Error('Codex session closed before turn admission'));
        this.queue.end();
      },
      getContextUsage: async () => {
        const usage = this.tokenUsage?.total;
        const totalTokens = usage?.totalTokens ?? 0;
        const maxTokens = this.tokenUsage?.modelContextWindow ?? 0;
        return {
          totalTokens,
          maxTokens,
          rawMaxTokens: maxTokens,
          percentage: maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0,
          model: this.deps.model ?? 'codex',
          categories: [
            { name: 'input', tokens: usage?.inputTokens ?? 0, color: '#60a5fa' },
            { name: 'cached input', tokens: usage?.cachedInputTokens ?? 0, color: '#34d399' },
            { name: 'output', tokens: usage?.outputTokens ?? 0, color: '#a78bfa' },
            { name: 'reasoning', tokens: usage?.reasoningOutputTokens ?? 0, color: '#f59e0b' },
          ],
        };
      },
      mcpServerStatus: async () => {
        const response = await this.manager.request<{
          data: Array<{
            name: string;
            tools: Record<string, { name: string; annotations?: unknown }>;
          }>;
        }>('mcpServerStatus/list', {});
        return response.data.map((server) => ({
          name: server.name,
          status: 'connected',
          tools: Object.values(server.tools).map((tool) => ({
            name: tool.name,
            annotations: codexToolAnnotations(tool.annotations),
          })),
        }));
      },
    } as unknown as Query;
    return { query, messages: this.queue.iterate() };
  }

  bindToolRequestHandler(handler: BackendToolRequestHandler): void {
    this.toolRequestHandler = handler;
  }

  private async run(input: AsyncIterable<SDKUserMessage>, options: Options): Promise<void> {
    let client: Awaited<ReturnType<CodexAppServerManager['ensureClient']>> | undefined;
    const notification = (message: { method: string; params: Record<string, unknown> }) => this.onNotification(message);
    const request = (message: {
      id: string | number;
      method: string;
      params?: Record<string, unknown>;
    }) => {
      if (!client) return;
      const activeClient = client;
      void this.onRequest(activeClient, message).catch((error) => {
        activeClient.respond(message.id, undefined, {
          code: -32603,
          message: error instanceof Error ? error.message : 'Codex interaction failed',
        });
      });
    };
    try {
      client = await this.manager.ensureClient();
      client.on('notification', notification);
      client.on('request', request);
      await this.manager.registerSkillRoots?.([
        path.join(this.deps.directory, '.claude', 'skills'),
        path.join(homedir(), '.claude', 'skills'),
      ]);
      await this.ensureThread(options);
      for await (const message of input) {
        if (this.closed) break;
        const clientTurnId = message.uuid ?? randomUUID();
        const skills = hasSlashReference(message.message.content)
          ? await this.manager.listSkills(this.deps.directory)
          : [];
        const response = await this.manager.request<{ turn: { id: string } }>('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: clientTurnId,
          input: codexUserInput(message.message.content, skills),
          ...(this.deps.model ? { model: this.deps.model } : {}),
          ...(this.deps.effort ? { effort: this.deps.effort } : {}),
          ...(this.deps.serviceTier ? { serviceTier: this.deps.serviceTier } : {}),
        });
        this.turnId = response.turn.id;
        this.pendingAdmissions.get(clientTurnId)?.resolve();
        this.pendingAdmissions.delete(clientTurnId);
      }
    } catch (error) {
      this.rejectPendingAdmissions(error);
      try {
        this.deps.onFatal?.(error);
      } catch {
        // Lifecycle cleanup must not replace the sanitized Codex error result.
      }
      this.queue.push(resultMessage(
        this.threadId ?? '',
        redactCodexError(error, this.deps.provider?.bearerToken),
      ));
    } finally {
      this.ended = true;
      this.rejectPendingAdmissions(new Error('Codex session ended before turn admission'));
      client?.off('notification', notification);
      client?.off('request', request);
      this.queue.end();
    }
  }

  private rejectPendingAdmissions(error: unknown): void {
    for (const admission of this.pendingAdmissions.values()) admission.reject(error);
    this.pendingAdmissions.clear();
  }

  private async onRequest(
    client: Awaited<ReturnType<CodexAppServerManager['ensureClient']>>,
    message: { id: string | number; method: string; params?: Record<string, unknown> },
  ): Promise<void> {
    const params = message.params ?? {};
    const requestThreadId = params.threadId ?? params.conversationId;
    if (typeof requestThreadId !== 'string' || requestThreadId !== this.threadId) return;
    const requestId = String(message.id);
    if (message.method === 'item/commandExecution/requestApproval') {
      const itemId = String(params.itemId ?? requestId);
      const result = await this.requestTool({
        requestId,
        toolUseId: itemId,
        toolName: 'Bash',
        input: { command: params.command, cwd: params.cwd },
        title: typeof params.reason === 'string' ? params.reason : undefined,
      });
      client.respond(message.id, { decision: result?.behavior === 'allow' ? 'accept' : 'decline' });
      return;
    }
    if (message.method === 'item/fileChange/requestApproval') {
      const itemId = String(params.itemId ?? requestId);
      const result = await this.requestTool({
        requestId,
        toolUseId: itemId,
        toolName: 'Edit',
        input: { grantRoot: params.grantRoot, reason: params.reason },
        title: typeof params.reason === 'string' ? params.reason : undefined,
      });
      client.respond(message.id, { decision: result?.behavior === 'allow' ? 'accept' : 'decline' });
      return;
    }
    if (message.method === 'execCommandApproval') {
      const callId = String(params.callId ?? requestId);
      const result = await this.requestTool({
        requestId,
        toolUseId: callId,
        toolName: 'Bash',
        input: { command: params.command, cwd: params.cwd },
        title: typeof params.reason === 'string' ? params.reason : undefined,
      });
      client.respond(message.id, {
        decision: result?.behavior === 'allow'
          ? 'approved'
          : { denied: { rejection: result?.message ?? 'Denied by Comate policy' } },
      });
      return;
    }
    if (message.method === 'applyPatchApproval') {
      const callId = String(params.callId ?? requestId);
      const result = await this.requestTool({
        requestId,
        toolUseId: callId,
        toolName: 'Edit',
        input: { fileChanges: params.fileChanges, grantRoot: params.grantRoot },
        title: typeof params.reason === 'string' ? params.reason : undefined,
      });
      client.respond(message.id, {
        decision: result?.behavior === 'allow'
          ? 'approved'
          : { denied: { rejection: result?.message ?? 'Denied by Comate policy' } },
      });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions)
        ? params.questions.map((value) => {
            const question = value as Record<string, unknown>;
            return {
              id: String(question.id ?? ''),
              question: String(question.question ?? ''),
              header: typeof question.header === 'string' ? question.header : undefined,
              options: Array.isArray(question.options)
                ? question.options.map((option) => {
                    const entry = option as Record<string, unknown>;
                    return {
                      label: String(entry.label ?? ''),
                      description: typeof entry.description === 'string' ? entry.description : undefined,
                    };
                  })
                : [],
              multiSelect: false,
            };
          })
        : [];
      const result = await this.requestTool({
        requestId,
        toolUseId: String(params.itemId ?? requestId),
        toolName: 'AskUserQuestion',
        input: { questions },
      });
      const updated = result?.behavior === 'allow'
        ? result.updatedInput as { answers?: Record<string, string> } | undefined
        : undefined;
      const answers = Object.fromEntries(questions.map((question) => [
        question.id,
        { answers: updated?.answers?.[question.question] ? [updated.answers[question.question]] : [] },
      ]));
      client.respond(message.id, { answers });
      return;
    }
    client.respond(message.id, undefined, {
      code: -32601,
      message: `Unsupported Codex server request: ${message.method}`,
    });
  }

  private requestTool(
    request: Parameters<BackendToolRequestHandler>[0],
  ): ReturnType<BackendToolRequestHandler> {
    if (!this.toolRequestHandler) return Promise.resolve({
      behavior: 'deny',
      message: 'Approval UI is unavailable for this Codex session',
    });
    return this.toolRequestHandler(request);
  }

  private async ensureThread(options: Options): Promise<void> {
    if (this.threadId) {
      const threadId = this.threadId;
      try {
        await this.manager.request('thread/resume', {
          threadId,
          cwd: this.deps.directory,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          config: this.threadConfig(options),
          ...(this.deps.serviceTier ? { serviceTier: this.deps.serviceTier } : {}),
          modelProvider: this.deps.provider ? 'comate-enterprise' : null,
          ...(this.deps.model ? { model: this.deps.model } : {}),
        });
        return;
      } catch (error) {
        if (!isMissingRollout(error, threadId)) throw error;
        this.threadId = undefined;
      }
    }
    const response = await this.manager.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.deps.directory,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: this.threadConfig(options),
      ...(this.deps.serviceTier ? { serviceTier: this.deps.serviceTier } : {}),
      ...(this.deps.provider ? { modelProvider: 'comate-enterprise' } : {}),
      ...(this.deps.model ? { model: this.deps.model } : {}),
    });
    this.threadId = response.thread.id;
    this.deps.onBackendSessionId(this.threadId);
  }

  private threadConfig(options: Options): Record<string, unknown> {
    return {
      ...codexThreadConfig(options, this.deps.provider),
      ...(this.deps.effort ? { model_reasoning_effort: this.deps.effort } : {}),
    };
  }

  private onNotification(message: { method: string; params: Record<string, unknown> }): void {
    const params = message.params;
    if (params.threadId !== this.threadId) return;
    if (message.method === 'thread/tokenUsage/updated') {
      this.tokenUsage = params.tokenUsage as typeof this.tokenUsage;
    }
    for (const mapped of this.mapper.map(message.method, params)) this.queue.push(mapped);
    if (message.method === 'turn/completed') {
      this.queue.push(resultMessage(
        this.threadId ?? '',
        redactCodexError(codexTurnFailure(params), this.deps.provider?.bearerToken),
      ));
      this.turnId = undefined;
    }
  }
}

function isMissingRollout(error: unknown, threadId: string): boolean {
  return error instanceof CodexRpcError
    && error.code === -32600
    && error.message === `no rollout found for thread id ${threadId}`;
}

function codexTurnFailure(params: Record<string, unknown>): Error | undefined {
  if (!params.turn || typeof params.turn !== 'object' || Array.isArray(params.turn)) return undefined;
  const turn = params.turn as Record<string, unknown>;
  if (turn.status !== 'failed') return undefined;
  const error = turn.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return new Error(message);
  }
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error('Codex turn failed');
}

function codexToolAnnotations(value: unknown): { readOnly?: boolean; destructive?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const annotations = value as Record<string, unknown>;
  return {
    ...(typeof annotations.readOnlyHint === 'boolean' ? { readOnly: annotations.readOnlyHint } : {}),
    ...(typeof annotations.destructiveHint === 'boolean' ? { destructive: annotations.destructiveHint } : {}),
  };
}

/**
 * Project stdio MCP commands/arguments can be passed as thread overrides.
 * Remote servers and stdio environment maps are deliberately excluded: both
 * commonly contain bearer/API credentials and Codex owns its persisted history.
 */
export function codexThreadConfig(
  options: Options,
  provider?: CodexProviderOverride,
): Record<string, unknown> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, rawConfig] of Object.entries(options.mcpServers ?? {})) {
    const config = rawConfig as Record<string, unknown>;
    if (config.type !== undefined && config.type !== 'stdio') continue;
    if (typeof config.command !== 'string' || config.command.length === 0) continue;
    mcpServers[name] = {
      command: config.command,
      ...(Array.isArray(config.args) && config.args.every((arg) => typeof arg === 'string')
        ? { args: config.args }
        : {}),
    };
  }
  return {
    ...(provider?.modelProfile?.contextWindow !== undefined
      ? { model_context_window: provider.modelProfile.contextWindow }
      : {}),
    ...(provider?.modelProfile?.autoCompactTokenLimit !== undefined
      ? { model_auto_compact_token_limit: provider.modelProfile.autoCompactTokenLimit }
      : {}),
    ...(provider?.modelProfile?.reasoningSummary !== undefined
      ? { model_reasoning_summary: provider.modelProfile.reasoningSummary }
      : {}),
    ...(provider?.modelProfile?.supportsReasoningSummaries !== undefined
      ? { model_supports_reasoning_summaries: provider.modelProfile.supportsReasoningSummaries }
      : {}),
    ...(provider?.modelProfile?.verbosity !== undefined
      ? { model_verbosity: provider.modelProfile.verbosity }
      : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    ...(provider ? {
      ...(provider.disableHostedTools ? {
        web_search: 'disabled',
      } : {}),
      model_providers: {
        'comate-enterprise': {
          name: provider.name,
          base_url: provider.baseUrl,
          wire_api: 'responses',
          requires_openai_auth: false,
          experimental_bearer_token: provider.bearerToken,
        },
      },
    } : {}),
  };
}

const SLASH_REFERENCE_PATTERN = /(^|\s)\/(\S+)/g;

function hasSlashReference(content: unknown): boolean {
  if (typeof content === 'string') return /(^|\s)\/\S+/.test(content);
  if (!Array.isArray(content)) return false;
  return content.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const block = value as { type?: unknown; text?: unknown };
    return block.type === 'text' &&
      typeof block.text === 'string' &&
      /(^|\s)\/\S+/.test(block.text);
  });
}

function codexSkillText(
  text: string,
  skillsByName: Map<string, CodexSkill>,
  referencedSkills: Map<string, CodexSkill>,
): string {
  return text.replace(SLASH_REFERENCE_PATTERN, (match, prefix: string, name: string) => {
    const skill = skillsByName.get(name);
    if (!skill) return match;
    referencedSkills.set(skill.path, skill);
    return `${prefix}$${name}`;
  });
}

export function codexUserInput(
  content: unknown,
  skills: CodexSkill[] = [],
): Array<Record<string, unknown>> {
  const values = Array.isArray(content)
    ? content
    : [{ type: 'text', text: typeof content === 'string' ? content : String(content ?? '') }];
  const input: Array<Record<string, unknown>> = [];
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const referencedSkills = new Map<string, CodexSkill>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const block = value as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      input.push({
        type: 'text',
        text: codexSkillText(block.text, skillsByName, referencedSkills),
        text_elements: [],
      });
    } else if (
      block.type === 'image' &&
      block.source?.type === 'base64' &&
      typeof block.source.media_type === 'string' &&
      typeof block.source.data === 'string'
    ) {
      input.push({
        type: 'image',
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      });
    }
  }
  for (const skill of referencedSkills.values()) {
    input.push({ type: 'skill', name: skill.name, path: skill.path });
  }
  return input.length > 0 ? input : [{ type: 'text', text: '', text_elements: [] }];
}

function resultMessage(sessionId: string, error?: unknown): SDKMessage {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  return {
    type: 'result', subtype: message ? 'error_during_execution' : 'success', is_error: Boolean(message),
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0,
    session_id: sessionId, ...(message ? { errors: [`codex backend error: ${message}`] } : {}),
  } as unknown as SDKMessage;
}

function redactCodexError(error: unknown, secret?: string): unknown {
  if (!(error instanceof Error) || !secret) return error;
  const sanitized = error.message.split(secret).join('[REDACTED]');
  return sanitized === error.message ? error : new Error(sanitized);
}
