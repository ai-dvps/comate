import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackendDriver } from './backend-driver.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';

interface CodexAdapterDeps {
  directory: string;
  backendSessionId?: string;
  model?: string;
  onBackendSessionId(id: string): void;
  manager?: CodexAppServerManager;
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
  private queue = new AsyncMessageQueue();
  private startedItems = new Set<string>();

  constructor(private readonly deps: CodexAdapterDeps) {
    this.manager = deps.manager ?? codexAppServerManager;
    this.threadId = deps.backendSessionId;
  }

  createStreamingQuery(input: AsyncIterable<SDKUserMessage>): { query: Query; messages: AsyncGenerator<SDKMessage> } {
    void this.run(input);
    const query = {
      interrupt: async () => {
        if (this.threadId && this.turnId) {
          await this.manager.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
        }
      },
      close: () => {
        this.closed = true;
        this.queue.end();
      },
    } as unknown as Query;
    return { query, messages: this.queue.iterate() };
  }

  private async run(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    const client = await this.manager.ensureClient();
    const notification = (message: { method: string; params: Record<string, unknown> }) => this.onNotification(message);
    const request = (message: { id: string | number; method: string }) => {
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        client.respond(message.id, { decision: 'decline' });
      } else if (message.method === 'execCommandApproval' || message.method === 'applyPatchApproval') {
        client.respond(message.id, { decision: { denied: { rejection: 'Approval UI is unavailable for this Codex session' } } });
      } else if (message.method === 'item/tool/requestUserInput') {
        client.respond(message.id, { answers: {} });
      } else {
        client.respond(message.id, undefined, { code: -32601, message: `Unsupported Codex server request: ${message.method}` });
      }
    };
    client.on('notification', notification);
    client.on('request', request);
    try {
      await this.ensureThread();
      for await (const message of input) {
        if (this.closed) break;
        const clientTurnId = message.uuid ?? randomUUID();
        const response = await this.manager.request<{ turn: { id: string } }>('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: clientTurnId,
          input: [{ type: 'text', text: textContent(message.message.content), text_elements: [] }],
          ...(this.deps.model ? { model: this.deps.model } : {}),
        });
        this.turnId = response.turn.id;
      }
    } catch (error) {
      this.queue.push(resultMessage(this.threadId ?? '', error));
    } finally {
      client.off('notification', notification);
      client.off('request', request);
      this.queue.end();
    }
  }

  private async ensureThread(): Promise<void> {
    if (this.threadId) {
      await this.manager.request('thread/resume', { threadId: this.threadId });
      return;
    }
    const response = await this.manager.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.deps.directory,
      ...(this.deps.model ? { model: this.deps.model } : {}),
    });
    this.threadId = response.thread.id;
    this.deps.onBackendSessionId(this.threadId);
  }

  private onNotification(message: { method: string; params: Record<string, unknown> }): void {
    const params = message.params;
    if (params.threadId !== this.threadId) return;
    if (message.method === 'item/agentMessage/delta') {
      const itemId = String(params.itemId);
      if (!this.startedItems.has(itemId)) {
        this.startedItems.add(itemId);
        this.queue.push({ type: 'stream_event', uuid: itemId, parent_tool_use_id: null, event: {
          type: 'message_start', message: { id: itemId, role: 'assistant', model: this.deps.model ?? 'codex', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        } } as unknown as SDKMessage);
        this.queue.push({ type: 'stream_event', uuid: itemId, parent_tool_use_id: null, event: {
          type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
        } } as unknown as SDKMessage);
      }
      this.queue.push({ type: 'stream_event', uuid: itemId, parent_tool_use_id: null, event: {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(params.delta ?? '') },
      } } as unknown as SDKMessage);
    } else if (message.method === 'turn/completed') {
      this.queue.push(resultMessage(this.threadId ?? '', undefined));
      this.turnId = undefined;
    }
  }
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => typeof part === 'object' && part && 'text' in part ? String(part.text) : '').join('\n');
}

function resultMessage(sessionId: string, error?: unknown): SDKMessage {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  return {
    type: 'result', subtype: message ? 'error_during_execution' : 'success', is_error: Boolean(message),
    duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0,
    session_id: sessionId, ...(message ? { errors: [`codex backend error: ${message}`] } : {}),
  } as unknown as SDKMessage;
}
