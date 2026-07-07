import type { Response } from 'express';
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKRateLimitInfo,
  SDKControlGetContextUsageResponse,
  HookCallback,
} from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent, QuestionPayload } from '../types/message.js';
import type { ApprovalMode } from '../models/session.js';
import { PushableIterator } from './pushable-iterator.js';
import { SseEmitter } from './sse-emitter.js';
import { SdkClient } from './sdk-client.js';
import { diagLog } from '../utils/diag-logger.js';
import { ReadLoopDetector, type ResolvedDeadLoopDetectionSettings } from './dead-loop-detector.js';


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
      expiresAt?: number;
      timer?: NodeJS.Timeout;
    }
  >();
  private closed = false;
  private messageLoopPromise: Promise<void> = Promise.resolve();
  private currentMessageStartId?: string;
  private activeRes: Response | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private botEventHandlers = new Set<(id: number, event: SseEvent) => void>();
  private webEventHandlers = new Set<(id: number, event: SseEvent) => void>();
  private onSubscribed?: () => void;
  private onUnsubscribed?: () => void;
  private onActivity?: () => void;
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
    onActivity?: () => void,
    deadLoopSettings?: ResolvedDeadLoopDetectionSettings,
  ): SessionRuntime {
    diagLog(`[Runtime ${sessionId}] SessionRuntime.open called`);
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
      onActivity,
      deadLoopSettings,
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
    for (const handler of this.botEventHandlers) {
      (handler as { cleanup?: () => void }).cleanup?.();
    }
    this.botEventHandlers.clear();
  }

  addWebEventHandler(handler: (id: number, event: SseEvent) => void): void {
    this.webEventHandlers.add(handler);
  }

  removeWebEventHandler(handler: (id: number, event: SseEvent) => void): void {
    this.webEventHandlers.delete(handler);
  }

  setApprovalMode(mode: ApprovalMode): void {
    diagLog(`[Runtime ${this.sessionId}] approvalMode changed: ${this.approvalMode} -> ${mode}`);
    this.approvalMode = mode;
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  private readLoopDetector?: ReadLoopDetector;
  private deadLoopSettings?: ResolvedDeadLoopDetectionSettings;
  private subagentLoopAlert?: {
    agentId: string;
    toolName: string;
    fingerprint: string;
    count: number;
    detectedAt: number;
    guidanceSent: boolean;
  };
  private subagentInterruptFired = false;

  private constructor(
    sessionId: string,
    workspaceId: string,
    serverNonce: string,
    input: PushableIterator<SDKUserMessage>,
    options: Options,
    sdkClient: SdkClient,
    onSubscribed?: () => void,
    onUnsubscribed?: () => void,
    onActivity?: () => void,
    deadLoopSettings?: ResolvedDeadLoopDetectionSettings,
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
    this.onActivity = onActivity;
    this.deadLoopSettings = deadLoopSettings;
    if (deadLoopSettings?.enabled) {
      this.readLoopDetector = new ReadLoopDetector(deadLoopSettings.line1);
    }
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
      for (const handler of this.webEventHandlers) {
        handler(id, event);
      }
      if (
        event.type === 'assistant_start' ||
        event.type === 'tool_result' ||
        event.type === 'assistant_done' ||
        event.type === 'result' ||
        event.type === 'compact_boundary'
      ) {
        this.emitContextUsage();
      }
    });
  }

  private start(): void {
    diagLog(`[Runtime ${this.sessionId}] start (hasCustomCanUseTool=${!!this.options.canUseTool})`);
    const baseCanUseTool = this.options.canUseTool ?? this.buildCanUseToolCallback();
    const canUseTool = this.readLoopDetector
      ? this.wrapCanUseToolWithDeadLoop(baseCanUseTool)
      : baseCanUseTool;
    const hooks: Options['hooks'] = { ...this.options.hooks };
    if (this.readLoopDetector) {
      hooks.PreToolUse = [{ matcher: 'Read', hooks: [this.createPreToolUseHook()] }];
      hooks.PostToolUse = [{ matcher: 'Read', hooks: [this.createPostToolUseHook()] }];
    }
    if (this.deadLoopSettings?.enabled) {
      hooks.Stop = [{ hooks: [this.createStopHook()] }];
      hooks.PostToolUse = [
        ...(hooks.PostToolUse ?? []),
        { hooks: [this.createSubagentPostToolUseHook()] },
      ];
    }
    const optionsWithCallback: Options = {
      ...this.options,
      canUseTool,
      ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
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
        this.onActivity?.();
        this.emitter.handle(msg);
      }
    } catch (err) {
      const errDetail = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack, ...(err as unknown as Record<string, unknown>) }
        : err;
      const errJson = JSON.stringify(errDetail, Object.getOwnPropertyNames(errDetail), 2);
      diagLog(`[Runtime ${this.sessionId}] message loop error: ${errJson}`);
      console.error('SessionRuntime message loop error:', err);

      const message = extractErrorMessage(err);
      const isNoConversationError = message.includes('No conversation found');
      const isOverloadedError =
        isRateLimitLike(err) || /(overloaded|rate.limit|529)/i.test(message);

      if (isNoConversationError) {
        // Fatal: the SDK has lost this session. Close the runtime so the
        // next client reconnect will trigger a fresh getOrCreateRuntime,
        // which can fall back to sessionId mode and recreate the conversation.
        diagLog(`[Runtime ${this.sessionId}] closing due to lost conversation`);
        this.closed = true;
        this.input.close();
      }

      if (isOverloadedError) {
        diagLog(`[Runtime ${this.sessionId}] detected overloaded/rate-limit error`);
        const rateLimitInfo = extractRateLimitInfo(err);
        if (rateLimitInfo) {
          this.emitter.emitRateLimit(rateLimitInfo);
          return;
        }
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
        decisionReasonType?: string;
      },
    ): Promise<PermissionResult> => {
      const requestId = options.toolUseID;

      if (toolName === 'AskUserQuestion') {
        const questions = this.parseAskUserQuestion(input);
        const timeout = this.parseTimeout(input);
        diagLog(`[Runtime ${this.sessionId}] emitPendingQuestion requestId=${requestId} questions=${questions.length} timeout=${timeout ?? 'none'}`);
        return this.requestToolQuestion(requestId, questions, input, {
          timeout,
          signal: options.signal,
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
      const timeout = this.parseTimeout(input);
      return this.requestToolApproval(requestId, toolName, options.toolUseID, input, {
        title: options.title,
        description: options.description,
        suggestions: options.suggestions,
        timeout,
        signal: options.signal,
        decisionReasonType: options.decisionReasonType,
      });
    };
  }

  private wrapCanUseToolWithDeadLoop(
    baseCanUseTool: (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        title?: string;
        description?: string;
        toolUseID: string;
        decisionReasonType?: string;
      },
    ) => Promise<PermissionResult>,
  ): (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      description?: string;
      toolUseID: string;
      decisionReasonType?: string;
    },
  ) => Promise<PermissionResult> {
    return async (toolName, input, options) => {
      if (toolName === 'Read' && typeof input.file_path === 'string' && this.readLoopDetector) {
        const action = this.readLoopDetector.beforeRead(input.file_path);
        if (action.type === 'block') {
          diagLog(
            `[Runtime ${this.sessionId}] dead-loop block tool=Read path=${input.file_path} toolUseId=${options.toolUseID}`,
          );
          return {
            behavior: 'deny',
            message: this.formatCachedResult(action.cachedResult),
          };
        }
      }
      return baseCanUseTool(toolName, input, options);
    };
  }

  private createPreToolUseHook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      if (input.tool_name !== 'Read') return {};
      const filePath = (input.tool_input as Record<string, unknown>)?.file_path;
      if (typeof filePath !== 'string' || !this.readLoopDetector) return {};

      const action = this.readLoopDetector.beforeRead(filePath);
      if (action.type === 'warn') {
        diagLog(`[Runtime ${this.sessionId}] dead-loop warn tool=Read path=${filePath}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: action.guidance,
          },
        };
      }
      return {};
    };
  }

  private createPostToolUseHook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      if (input.tool_name !== 'Read') return {};
      const filePath = (input.tool_input as Record<string, unknown>)?.file_path;
      if (typeof filePath !== 'string' || !this.readLoopDetector) return {};

      this.readLoopDetector.recordReadResult(filePath, input.tool_response);
      return {};
    };
  }

  private formatCachedResult(result: unknown): string {
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  setSubagentLoopAlert(alert: {
    agentId: string;
    toolName: string;
    fingerprint: string;
    count: number;
  }): void {
    const existing = this.subagentLoopAlert;
    if (
      existing &&
      existing.agentId === alert.agentId &&
      existing.fingerprint === alert.fingerprint
    ) {
      existing.count = alert.count;
      return;
    }
    this.subagentLoopAlert = { ...alert, detectedAt: Date.now(), guidanceSent: false };
    this.subagentInterruptFired = false;
  }

  clearSubagentLoopAlert(): void {
    this.subagentLoopAlert = undefined;
    this.subagentInterruptFired = false;
  }

  getSubagentLoopAlert():
    | {
        agentId: string;
        toolName: string;
        fingerprint: string;
        count: number;
        detectedAt: number;
        guidanceSent: boolean;
      }
    | undefined {
    return this.subagentLoopAlert;
  }

  hasSubagentInterruptFired(): boolean {
    return this.subagentInterruptFired;
  }

  markSubagentInterruptFired(): void {
    this.subagentInterruptFired = true;
  }

  private getSubagentLoopGuidance(): string | undefined {
    const alert = this.subagentLoopAlert;
    if (!alert || alert.guidanceSent) {
      return undefined;
    }
    alert.guidanceSent = true;
    return `Subagent ${alert.agentId} appears to be stuck in a loop calling ${alert.toolName} with the same arguments (${alert.count} repetitions in the trailing window). Consider using TaskStop to stop it.`;
  }

  private createStopHook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'Stop') return {};
      const guidance = this.getSubagentLoopGuidance();
      if (!guidance) return {};
      diagLog(`[Runtime ${this.sessionId}] dead-loop subagent guidance via Stop hook`);
      return {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: guidance,
        },
      };
    };
  }

  private createSubagentPostToolUseHook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      const guidance = this.getSubagentLoopGuidance();
      if (!guidance) return {};
      diagLog(`[Runtime ${this.sessionId}] dead-loop subagent guidance via PostToolUse hook`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: guidance,
        },
      };
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

  private parseTimeout(input: Record<string, unknown>): number | undefined {
    const timeout = input.timeout;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return undefined;
    }
    return timeout;
  }

  private startTimeoutTimer(requestId: string, timeout: number): { expiresAt: number; timer: NodeJS.Timeout } {
    const expiresAt = Date.now() + timeout;
    const timer = setTimeout(() => this.timeoutDeny(requestId), timeout);
    return { expiresAt, timer };
  }

  private timeoutDeny(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    const toolName = pending.toolName ?? 'unknown';
    const toolUseId = pending.toolUseId ?? 'none';
    diagLog(`[Runtime ${this.sessionId}] ask deny requestId=${requestId} tool=${toolName} toolUseId=${toolUseId} reason=timeout`);
    this.emitter.emitApprovalTimeout(requestId);
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);
    pending.resolve({
      behavior: 'deny',
      message: 'Request timed out waiting for user response.',
    });
  }

  private clearPendingTimer(pending: { timer?: NodeJS.Timeout }): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
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
        this.emitter.emitPendingQuestion(requestId, pending.questions ?? [], pending.expiresAt);
      } else {
        this.emitter.emitPendingApproval(
          requestId,
          pending.toolName ?? '',
          pending.toolUseId ?? '',
          pending.input,
          pending.title,
          pending.description,
          pending.suggestions,
          pending.expiresAt,
        );
      }
    }
    this.onSubscribed?.();
    this.onActivity?.();
  }

  subscribeWebSocket(handler: (id: number, event: SseEvent) => void, lastEventId?: string): void {
    diagLog(`[Runtime ${this.sessionId}] subscribeWebSocket (pending=${this.pendingApprovals.size}, lastEventId=${lastEventId ?? 'none'}, currentMessageStartId=${this.currentMessageStartId ?? 'none'})`);
    this.addWebEventHandler(handler);
    this.emitter.emitWebEvent({ type: 'subscription_ack', serverNonce: this.serverNonce, sessionId: this.sessionId });
    if (lastEventId !== undefined) {
      this.replayFromWebSocket(lastEventId, handler);
    } else if (this.currentMessageStartId !== undefined) {
      // Fresh subscription mid-turn: include the assistant_start event itself so
      // the client creates the assistant message rather than only seeing deltas.
      this.replayFromWebSocket(this.currentMessageStartId, handler, true);
    }
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.type === 'question') {
        this.emitter.emitPendingQuestion(requestId, pending.questions ?? [], pending.expiresAt);
      } else {
        this.emitter.emitPendingApproval(
          requestId,
          pending.toolName ?? '',
          pending.toolUseId ?? '',
          pending.input,
          pending.title,
          pending.description,
          pending.suggestions,
          pending.expiresAt,
        );
      }
    }
    this.onSubscribed?.();
    this.onActivity?.();
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

  getStatus(): { pendingCount: number; isProcessing: boolean; workspaceId: string } {
    return {
      pendingCount: this.pendingApprovals.size,
      isProcessing: this.isProcessingTurn(),
      workspaceId: this.workspaceId,
    };
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.query.getContextUsage();
  }

  private emitContextUsage(): void {
    this.getContextUsage()
      .then((usage) => {
        if (this.closed) return;
        this.emitter.emitEvent({
          type: 'context_usage',
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          categories: usage.categories.map((category) => ({
            name: category.name,
            tokens: category.tokens,
          })),
        });
      })
      .catch((err) => {
        diagLog(
          `[Runtime ${this.sessionId}] getContextUsage failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  isClosed(): boolean {
    return this.closed;
  }

  isProcessingTurn(): boolean {
    return this.currentMessageStartId !== undefined || this.pendingApprovals.size > 0;
  }

  cancelIdleClose(): void {
    // In the current architecture ChatService passes cancelIdleClose as onSubscribed;
    // invoking it here prevents the idle-close timer from firing while we dispatch.
    this.onSubscribed?.();
  }

  pushMessage(content: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    this.input.push(msg);
    this.onActivity?.();
  }

  resolveApproval(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.clearPendingTimer(pending);
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

  /**
   * Expose the type and context of a pending card action so that external
   * responders (e.g. WeCom template-card clicks) can resolve approvals or
   * questions without duplicating the pending-approval map.
   */
  getPendingCardState(
    requestId: string,
  ):
    | { type: 'approval'; toolName?: string; toolUseId?: string; suggestions?: PermissionUpdate[] }
    | { type: 'question'; questions: QuestionPayload[] }
    | undefined {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return undefined;
    if (pending.type === 'question') {
      return { type: 'question', questions: pending.questions ?? [] };
    }
    return {
      type: 'approval',
      toolName: pending.toolName,
      toolUseId: pending.toolUseId,
      suggestions: pending.suggestions,
    };
  }

  /**
   * Registers a pending tool approval, emits the pending_approval SSE event,
   * and returns a Promise that resolves when resolveApproval is called.
   * Used by the bot canUseTool callback to mirror the GUI approval flow.
   */
  requestToolApproval(
    requestId: string,
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    options: {
      title?: string;
      description?: string;
      suggestions?: PermissionUpdate[];
      timeout?: number;
      signal?: AbortSignal;
      decisionReasonType?: string;
    } = {},
  ): Promise<PermissionResult> {
    const timerInfo = options.timeout ? this.startTimeoutTimer(requestId, options.timeout) : undefined;
    this.emitter.emitPendingApproval(
      requestId,
      toolName,
      toolUseId,
      input,
      options.title,
      options.description,
      options.suggestions,
      timerInfo?.expiresAt,
      options.decisionReasonType,
    );
    return this.waitForResolution(requestId, input, 'approval', {
      toolName,
      toolUseId,
      title: options.title,
      description: options.description,
      suggestions: options.suggestions,
      expiresAt: timerInfo?.expiresAt,
      timer: timerInfo?.timer,
      signal: options.signal,
    });
  }

  /**
   * Registers a pending question, emits the pending_question SSE event,
   * and returns a Promise that resolves when resolveApproval is called.
   * Used by the bot canUseTool callback to mirror the GUI question flow.
   */
  requestToolQuestion(
    requestId: string,
    questions: QuestionPayload[],
    input: Record<string, unknown>,
    options: {
      timeout?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<PermissionResult> {
    const timerInfo = options.timeout ? this.startTimeoutTimer(requestId, options.timeout) : undefined;
    this.emitter.emitPendingQuestion(requestId, questions, timerInfo?.expiresAt);
    return this.waitForResolution(requestId, input, 'question', {
      questions,
      expiresAt: timerInfo?.expiresAt,
      timer: timerInfo?.timer,
      signal: options.signal,
    });
  }

  private waitForResolution(
    requestId: string,
    input: Record<string, unknown>,
    type: 'approval' | 'question',
    data: {
      toolName?: string;
      toolUseId?: string;
      title?: string;
      description?: string;
      suggestions?: PermissionUpdate[];
      questions?: QuestionPayload[];
      expiresAt?: number;
      timer?: NodeJS.Timeout;
      signal?: AbortSignal;
    },
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        input,
        type,
        ...(data.toolName !== undefined && { toolName: data.toolName }),
        ...(data.toolUseId !== undefined && { toolUseId: data.toolUseId }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.suggestions !== undefined && { suggestions: data.suggestions }),
        ...(data.questions !== undefined && { questions: data.questions }),
        ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt }),
        ...(data.timer !== undefined && { timer: data.timer }),
      });

      if (data.signal) {
        const onAbort = () => {
          const pending = this.pendingApprovals.get(requestId);
          if (pending) {
            const toolName = pending.toolName ?? 'unknown';
            const toolUseId = pending.toolUseId ?? 'none';
            diagLog(`[Runtime ${this.sessionId}] ask deny requestId=${requestId} tool=${toolName} toolUseId=${toolUseId} reason=abort`);
            this.clearPendingTimer(pending);
            this.pendingApprovals.delete(requestId);
            this.emitter.emitApprovalResolved(requestId);
            resolve({
              behavior: 'deny',
              message: `Tool approval aborted by SDK: ${requestId}`,
            });
          }
        };
        data.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
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

  /**
   * Resolve all pending tool approvals or questions as denied. Used when a turn
   * is interrupted so the user lands in a clean state and reconnecting clients
   * do not replay stale approval cards.
   */
  cancelPendingApprovals(message = 'Turn interrupted by user.'): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      this.clearPendingTimer(pending);
      this.pendingApprovals.delete(requestId);
      this.emitter.emitApprovalResolved(requestId);
      pending.resolve({ behavior: 'deny', message });
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
      const hasMissableEvents = this.ringBuffer.some(
        (item) => item.event.type !== 'subscription_ack',
      );
      if (hasMissableEvents) {
        this.emitter.emitErrorNote(
          'Some output may have been missed due to reconnect.',
        );
      }
      return;
    }
    for (let i = startIndex + 1; i < this.ringBuffer.length; i++) {
      const item = this.ringBuffer[i];
      res.write(SseEmitter.formatSsePayload(item.id, item.event));
    }
  }

  private replayFromWebSocket(lastEventId: string, handler: (id: number, event: SseEvent) => void, inclusive = false): void {
    const startIndex = this.ringBuffer.findIndex(
      (item) => item.id === lastEventId,
    );
    if (startIndex < 0) {
      for (const item of this.ringBuffer) {
        handler(Number(item.id), item.event);
      }
      const hasMissableEvents = this.ringBuffer.some(
        (item) => item.event.type !== 'subscription_ack',
      );
      if (hasMissableEvents) {
        this.emitter.emitErrorNote(
          'Some output may have been missed due to reconnect.',
        );
      }
      return;
    }
    for (let i = startIndex + (inclusive ? 0 : 1); i < this.ringBuffer.length; i++) {
      const item = this.ringBuffer[i];
      handler(Number(item.id), item.event);
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
    try {
      this.query.close();
    } catch {
      // Ignore close errors during cleanup
    }
    await this.messageLoopPromise.catch(() => {});
    this.unsubscribe();
    // Resolve any dangling pending approvals so their Promises don't leak
    for (const [requestId, pending] of this.pendingApprovals) {
      this.clearPendingTimer(pending);
      pending.resolve({
        behavior: 'deny',
        message: `Session closed while waiting for approval: ${requestId}`,
      });
    }
    this.pendingApprovals.clear();
  }
}

function extractRateLimitInfo(err: unknown): SDKRateLimitInfo | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const info = e.rate_limit_info ?? e.rateLimitInfo;
  if (info && typeof info === 'object') {
    return info as SDKRateLimitInfo;
  }
  return undefined;
}

function isRateLimitLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (e.error === 'overloaded' || e.error === 'rate_limit') return true;
  if (typeof e.message === 'string' && /(overloaded|rate.limit|529)/i.test(e.message)) return true;
  return false;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (typeof e.error === 'string' && e.error.length > 0) return e.error;
    if (typeof e.error === 'object' && e.error !== null) {
      const sub = e.error as Record<string, unknown>;
      if (typeof sub.message === 'string' && sub.message.length > 0) return sub.message;
    }
  }
  const str = String(err);
  return str === '[object Object]' ? 'Unknown SDK error' : str;
}
