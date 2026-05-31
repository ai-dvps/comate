import type { Response } from 'express';
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  PermissionUpdate,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent, QuestionPayload } from '../types/message.js';
import type { ApprovalMode } from '../models/session.js';
import { PushableIterator } from './pushable-iterator.js';
import { SseEmitter } from './sse-emitter.js';
import { SdkClient } from './sdk-client.js';
import { diagLog } from '../utils/diag-logger.js';


const RING_BUFFER_CAP = 500;
diagLog('[SessionRuntime] module loaded');

const READONLY_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'LSP',
  'WebSearch',
  'WebFetch',
];

export class SessionRuntime {
  private sessionId: string;
  private workspaceId: string;
  private serverNonce: string;
  private options: Options;
  private sdkClient: SdkClient;
  private input: PushableIterator<SDKUserMessage>;
  private query!: Query;
  private emitter: SseEmitter;
  private ringBuffer: Array<{ id: string; event: SseEvent }> = [];
  private pendingApprovals = new Map<
    string,
    {
      resolve: (result: PermissionResult) => void;
      input: Record<string, unknown>;
      type: 'approval' | 'question';
      toolName?: string;
      toolUseId?: string;
      title?: string;
      description?: string;
      suggestions?: PermissionUpdate[];
      questions?: QuestionPayload[];
    }
  >();
  private closed = false;
  private messageLoopPromise: Promise<void> = Promise.resolve();
  private currentMessageStartId?: string;
  private activeRes: Response | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private botEventHandlers = new Set<(id: number, event: SseEvent) => void>();
  private onSubscribed?: () => void;
  private onUnsubscribed?: () => void;
  private approvalMode: ApprovalMode = 'manual';

  static open(
    sessionId: string,
    workspaceId: string,
    serverNonce: string,
    options: Options,
    sdkClient: SdkClient,
    botEventHandler?: (id: number, event: SseEvent) => void,
    onSubscribed?: () => void,
    onUnsubscribed?: () => void,
  ): SessionRuntime {
    const input = new PushableIterator<SDKUserMessage>();
    const runtime = new SessionRuntime(
      sessionId,
      workspaceId,
      serverNonce,
      input,
      options,
      sdkClient,
      onSubscribed,
      onUnsubscribed,
    );
    if (botEventHandler) {
      runtime.botEventHandlers.add(botEventHandler);
    }
    runtime.start();
    return runtime;
  }

  addBotEventHandler(handler: (id: number, event: SseEvent) => void): void {
    this.botEventHandlers.add(handler);
  }

  removeBotEventHandler(handler: (id: number, event: SseEvent) => void): void {
    this.botEventHandlers.delete(handler);
  }

  clearBotEventHandlers(): void {
    this.botEventHandlers.clear();
  }

  setApprovalMode(mode: ApprovalMode): void {
    diagLog(`[Runtime ${this.sessionId}] approvalMode changed: ${this.approvalMode} -> ${mode}`);
    this.approvalMode = mode;
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  private constructor(
    sessionId: string,
    workspaceId: string,
    serverNonce: string,
    input: PushableIterator<SDKUserMessage>,
    options: Options,
    sdkClient: SdkClient,
    onSubscribed?: () => void,
    onUnsubscribed?: () => void,
  ) {
    diagLog(`[Runtime ${sessionId}] constructed`);
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.serverNonce = serverNonce;
    this.input = input;
    this.options = options;
    this.sdkClient = sdkClient;
    this.onSubscribed = onSubscribed;
    this.onUnsubscribed = onUnsubscribed;
    this.emitter = new SseEmitter(null, (id, event) => {
      if (event.type === 'assistant_start') {
        this.currentMessageStartId = String(id);
      } else if (event.type === 'assistant_done' || event.type === 'interrupted') {
        this.currentMessageStartId = undefined;
      }
      this.ringBuffer.push({ id: String(id), event });
      if (this.ringBuffer.length > RING_BUFFER_CAP) {
        this.ringBuffer.shift();
      }
      for (const handler of this.botEventHandlers) {
        handler(id, event);
      }
    });
  }

  private start(): void {
    diagLog(`[Runtime ${this.sessionId}] start (hasCustomCanUseTool=${!!this.options.canUseTool})`);
    const optionsWithCallback: Options = {
      ...this.options,
      canUseTool: this.options.canUseTool ?? this.buildCanUseToolCallback(),
    };
    const { query, messages } = this.sdkClient.createStreamingQuery(
      this.input,
      optionsWithCallback,
    );
    this.query = query;
    this.messageLoopPromise = this.runMessageLoop(messages);
  }

  private async runMessageLoop(
    messages: AsyncGenerator<SDKMessage>,
  ): Promise<void> {
    try {
      for await (const msg of messages) {
        if (this.closed) break;
        this.emitter.handle(msg);
      }
    } catch (err) {
      const errDetail = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack, ...(err as unknown as Record<string, unknown>) }
        : err;
      const errJson = JSON.stringify(errDetail, Object.getOwnPropertyNames(errDetail), 2);
      diagLog(`[Runtime ${this.sessionId}] message loop error: ${errJson}`);
      console.error('SessionRuntime message loop error:', err);

      const message = err instanceof Error ? err.message : String(err);
      const isNoConversationError = message.includes('No conversation found');

      if (isNoConversationError) {
        // Fatal: the SDK has lost this session. Close the runtime so the
        // next client reconnect will trigger a fresh getOrCreateRuntime,
        // which can fall back to sessionId mode and recreate the conversation.
        diagLog(`[Runtime ${this.sessionId}] closing due to lost conversation`);
        this.closed = true;
        this.input.close();
      }

      this.emitter.emitErrorNote(
        `Stream error: ${message}`,
      );
    }
  }

  private buildCanUseToolCallback() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
        title?: string;
        description?: string;
        toolUseID: string;
      },
    ): Promise<PermissionResult> => {
      const requestId = options.toolUseID;

      if (toolName === 'AskUserQuestion') {
        const questions = this.parseAskUserQuestion(input);
        diagLog(`[Runtime ${this.sessionId}] emitPendingQuestion requestId=${requestId} questions=${questions.length}`);
        this.emitter.emitPendingQuestion(requestId, questions);
        return new Promise<PermissionResult>((resolve) => {
          this.pendingApprovals.set(requestId, {
            resolve,
            input,
            type: 'question',
            questions,
          });

          if (options.signal) {
            const onAbort = () => {
              this.pendingApprovals.delete(requestId);
              this.emitter.emitApprovalResolved(requestId);
              resolve({
                behavior: 'deny',
                message: `Tool approval aborted by SDK: ${requestId}`,
              });
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }

      // Check approval mode (after AskUserQuestion guard — questions always require user input)
      if (this.approvalMode === 'auto') {
        diagLog(`[Runtime ${this.sessionId}] auto-approve tool=${toolName} requestId=${requestId}`);
        this.emitter.emitAutoApproval(requestId, toolName, 'auto');
        return { behavior: 'allow', updatedInput: input };
      }

      if (this.approvalMode === 'readonly' && READONLY_TOOLS.includes(toolName)) {
        diagLog(`[Runtime ${this.sessionId}] readonly-auto-approve tool=${toolName} requestId=${requestId}`);
        this.emitter.emitAutoApproval(requestId, toolName, 'readonly');
        return { behavior: 'allow', updatedInput: input };
      }

      diagLog(`[Runtime ${this.sessionId}] emitPendingApproval requestId=${requestId} toolName=${toolName}`);
      this.emitter.emitPendingApproval(
        requestId,
        toolName,
        options.toolUseID,
        input,
        options.title,
        options.description,
        options.suggestions,
      );

      return new Promise<PermissionResult>((resolve) => {
        this.pendingApprovals.set(requestId, {
          resolve,
          input,
          type: 'approval',
          toolName,
          toolUseId: options.toolUseID,
          title: options.title,
          description: options.description,
          suggestions: options.suggestions,
        });

        if (options.signal) {
          const onAbort = () => {
            this.pendingApprovals.delete(requestId);
            this.emitter.emitApprovalResolved(requestId);
            resolve({
              behavior: 'deny',
              message: `Tool approval aborted by SDK: ${requestId}`,
            });
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    };
  }

  private parseAskUserQuestion(
    input: Record<string, unknown>,
  ): QuestionPayload[] {
    const questions = input.questions;
    if (!Array.isArray(questions)) return [];
    return questions.map((q: unknown) => {
      const qx = q as Record<string, unknown>;
      return {
        question: typeof qx.question === 'string' ? qx.question : '',
        header: typeof qx.header === 'string' ? qx.header : undefined,
        options: Array.isArray(qx.options)
          ? qx.options.map((o: unknown) => {
              const ox = o as Record<string, unknown>;
              return {
                label: typeof ox.label === 'string' ? ox.label : '',
                description:
                  typeof ox.description === 'string'
                    ? ox.description
                    : undefined,
                preview:
                  typeof ox.preview === 'string' ? ox.preview : undefined,
              };
            })
          : [],
        multiSelect: qx.multiSelect === true,
      };
    });
  }

  subscribe(res: Response, lastEventId?: string): void {
    diagLog(`[Runtime ${this.sessionId}] subscribe (pending=${this.pendingApprovals.size}, lastEventId=${lastEventId ?? 'none'}, currentMessageStartId=${this.currentMessageStartId ?? 'none'})`);
    this.activeRes = res;
    this.emitter.setResponse(res);
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.emitter.emitHeartbeat(), 15000);
    }
    this.emitter.emitSubscriptionAck(this.serverNonce, this.sessionId);
    if (lastEventId !== undefined) {
      this.replayFrom(lastEventId, res);
    } else if (this.currentMessageStartId !== undefined) {
      this.replayFrom(this.currentMessageStartId, res);
    }
    // Re-emit any currently pending approvals so reconnecting clients
    // always see the current state even if they missed the original event.
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.type === 'question') {
        this.emitter.emitPendingQuestion(requestId, pending.questions ?? []);
      } else {
        this.emitter.emitPendingApproval(
          requestId,
          pending.toolName ?? '',
          pending.toolUseId ?? '',
          pending.input,
          pending.title,
          pending.description,
          pending.suggestions,
        );
      }
    }
    this.onSubscribed?.();
  }

  unsubscribe(res?: Response): void {
    const hadRes = this.activeRes === res;
    if (!res || this.activeRes === res) {
      this.activeRes = null;
      this.emitter.setResponse(null);
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
    }
    diagLog(`[Runtime ${this.sessionId}] unsubscribe (matched=${hadRes})`);
    if (hadRes) {
      this.onUnsubscribed?.();
    }
  }

  getStatus(): { pendingCount: number; workspaceId: string } {
    return {
      pendingCount: this.pendingApprovals.size,
      workspaceId: this.workspaceId,
    };
  }

  isClosed(): boolean {
    return this.closed;
  }

  pushMessage(content: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    this.input.push(msg);
  }

  resolveApproval(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);

    // The SDK's Zod schema requires `updatedInput: Record<string, unknown>` on
    // every allow result, even though the TS type marks it optional. Callers
    // (HTTP route, abort handler) shouldn't have to know this — fill from the
    // cached tool input when missing.
    const finalResult: PermissionResult =
      result.behavior === 'allow' && result.updatedInput === undefined
        ? { ...result, updatedInput: pending.input }
        : result;

    pending.resolve(finalResult);
  }

  async interrupt(): Promise<void> {
    try {
      await this.query.interrupt();
      this.emitter.emitInterrupted(null);
    } catch (err) {
      console.error('Interrupt failed:', err);
      this.emitter.emitErrorNote(
        `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private replayFrom(lastEventId: string, res: Response): void {
    const startIndex = this.ringBuffer.findIndex(
      (item) => item.id === lastEventId,
    );
    if (startIndex < 0) {
      for (const item of this.ringBuffer) {
        res.write(SseEmitter.formatSsePayload(item.id, item.event));
      }
      this.emitter.emitErrorNote(
        'Some output may have been missed due to reconnect.',
      );
      return;
    }
    for (let i = startIndex + 1; i < this.ringBuffer.length; i++) {
      const item = this.ringBuffer[i];
      res.write(SseEmitter.formatSsePayload(item.id, item.event));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    try {
      await this.query.interrupt();
    } catch {
      // Ignore interrupt errors during close
    }
    await this.messageLoopPromise.catch(() => {});
    this.unsubscribe();
  }
}
