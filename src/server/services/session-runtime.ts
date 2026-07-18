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
} from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent, QuestionPayload, TaskSignal } from '../types/message.js';
import type { ApprovalMode } from '../models/session.js';
import type { Provider } from '../models/provider.js';
import { PushableIterator } from './pushable-iterator.js';
import { SseEmitter } from './sse-emitter.js';
import { SdkClient } from './sdk-client.js';
import { diagLog } from '../utils/diag-logger.js';
import { KimiLoopDetector, isKimiProvider } from './kimi-loop-detector.js';
import { BROWSER_TOOL_NAMES } from './browser-tool-names.js';
import {
  commitSessionNavigation,
  evaluateSessionNavigation,
  isBrowserSubmitClassified,
  redactSubmitGateInput,
} from './browser-gate-state.js';


const RING_BUFFER_CAP = 500;
// Bounded FIFO tombstones: terminated task ids are remembered so a late
// confirmation cannot resurrect a finished task as a ghost (Critical-Gap-2).
const TERMINATED_TASK_IDS_CAP = 256;
// Bounded FIFO record of ambient (skip_transcript) task ids so a later
// backgrounded signal cannot confirm a task that must never be tracked (R3).
const SKIPPED_TASK_IDS_CAP = 256;
diagLog('[SessionRuntime] module loaded');

const READONLY_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'LSP',
  'WebSearch',
  'WebFetch',
  // Browser read-only probes (U4, KTD-4 ③: annotated readOnlyHint in U3).
  BROWSER_TOOL_NAMES.snapshot,
  BROWSER_TOOL_NAMES.extract,
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
  // Background-task tracker (R1-R4). A bare task_started creates only a
  // candidate; membership in confirmedBackgroundTasks requires a
  // confirmed-background signal (asyncLaunched / bashBackgrounded /
  // backgroundedPatch) or the single-candidate fallback.
  private taskCandidates = new Map<string, { toolUseId?: string }>();
  private confirmedBackgroundTasks = new Set<string>();
  // tool_use_ids of asyncLaunched results that arrived before their task_started.
  private pendingConfirmations = new Set<string>();
  private terminatedTaskIds = new Set<string>();
  private skippedTaskIds = new Set<string>();
  // Baseline is idle: a fresh runtime never announces {processing: false}.
  private lastEmittedProcessing = false;
  // Count companion to lastEmittedProcessing: count-only changes (e.g. a
  // second task confirmed while already processing) also ship an edge.
  private lastEmittedBackgroundTaskCount = 0;
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
    provider?: Provider,
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
      provider,
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

  private provider?: Provider;
  private kimiLoopDetector?: KimiLoopDetector;

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
    provider?: Provider,
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
    this.provider = provider;
    if (provider && isKimiProvider(provider)) {
      this.kimiLoopDetector = new KimiLoopDetector();
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
    }, (signal) => this.handleTaskSignal(signal));
  }

  private start(): void {
    diagLog(`[Runtime ${this.sessionId}] start (hasCustomCanUseTool=${!!this.options.canUseTool})`);
    const baseCanUseTool = this.options.canUseTool ?? this.buildCanUseToolCallback();
    const canUseTool = this.kimiLoopDetector
      ? this.wrapCanUseToolWithKimiLoopDetection(baseCanUseTool)
      : baseCanUseTool;
    const hooks: Options['hooks'] = { ...this.options.hooks };
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
        this.emitter.handle(msg);
        this.evaluateProcessingEdge();
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
    } finally {
      // The loop is permanently dead (error or stream end) — no further
      // task signals can arrive, so tracked background tasks can never
      // settle. Reconcile the tracker so the session can idle instead of
      // pinning in the processing state forever. The edge guard suppresses
      // the emission when nothing actually changed.
      this.taskCandidates.clear();
      this.confirmedBackgroundTasks.clear();
      this.evaluateProcessingEdge();
    }
  }

  private buildCanUseToolCallback() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        title?: string;
        description?: string;
        toolUseID: string;
        decisionReasonType?: string;
        requestId: string;
      },
    ): Promise<PermissionResult | null> => {
      const requestId = options.requestId ?? options.toolUseID;

      if (toolName === 'AskUserQuestion') {
        const questions = this.parseAskUserQuestion(input);
        const timeout = this.parseTimeout(input);
        diagLog(`[Runtime ${this.sessionId}] emitPendingQuestion requestId=${requestId} questions=${questions.length} timeout=${timeout ?? 'none'}`);
        return this.requestToolQuestion(requestId, questions, input, {
          timeout,
          signal: options.signal,
        });
      }

      // ------------------------------------------------------------------
      // Browser gates (U4, KTD-4 ②). These live in the BASE callback (the
      // Kimi wrapper wraps around it) and BEFORE the auto branch so auto
      // mode can never silently approve them.
      //
      // Submit classification: provable submits (submit tool; act clicking a
      // submit-semantics control) always go through a per-call confirmation.
      // This is the FIRST gate + UI entry — the real hard gate (sanitized
      // manifest + TOCTOU re-read) lives in the submit tool's handler (U3)
      // and fires even when a workspace `.claude/settings.json` allow rule
      // short-circuits canUseTool entirely. The raw submit input is redacted
      // here (KTD-8: field names may flow, values never).
      if (isBrowserSubmitClassified(this.sessionId, toolName, input)) {
        diagLog(`[Runtime ${this.sessionId}] browser-submit-gate requestId=${requestId} tool=${toolName}`);
        return this.requestToolApproval(
          requestId,
          toolName,
          options.toolUseID,
          redactSubmitGateInput(toolName, input),
          {
            title: options.title ?? 'Confirm form submission',
            description:
              options.description ??
              'This action submits a form. The browser tool will ask you to review the destination and fields before dispatching.',
            signal: options.signal,
            decisionReasonType: options.decisionReasonType,
          },
        );
      }

      // Navigation surface: in auto mode the session's first cross-eTLD+1
      // navigation requires one confirmation (session-level memory in
      // browser-gate-state — no persistent domain ledger, KTD-4 ②); later
      // crossings pass with an audit marker (diagLog placeholder — the
      // browser_audit table lands with U8). Manual/readonly modes follow the
      // generic approval flow below and record the visit on approval.
      if (toolName === BROWSER_TOOL_NAMES.open) {
        const url = typeof input.url === 'string' ? input.url : undefined;
        const nav = url
          ? evaluateSessionNavigation(this.sessionId, url)
          : ({ kind: 'invalid' } as const);
        if (nav.kind === 'needs-confirm' && this.approvalMode === 'auto') {
          diagLog(`[Runtime ${this.sessionId}] browser-navigation-confirm requestId=${requestId} domain=${nav.domain}`);
          const result = await this.requestToolApproval(
            requestId,
            toolName,
            options.toolUseID,
            { kind: 'browser_navigation', url, domain: nav.domain },
            {
              title: `Navigate to a new site: ${nav.domain}`,
              description:
                'The embedded browser is leaving the sites it has already visited this session. Confirm this first cross-site navigation; later ones only get an audit marker.',
              signal: options.signal,
              decisionReasonType: options.decisionReasonType,
            },
          );
          if (result.behavior === 'allow') {
            commitSessionNavigation(this.sessionId, nav.domain, { confirmedCrossing: true });
            diagLog(`[browser-audit] navigation session=${this.sessionId} domain=${nav.domain} kind=first-cross-confirmed`);
            return { behavior: 'allow', updatedInput: input };
          }
          return result;
        }
        if (nav.kind === 'allow' && this.approvalMode === 'auto') {
          commitSessionNavigation(this.sessionId, nav.domain);
          if (nav.auditCrossing) {
            diagLog(`[browser-audit] navigation session=${this.sessionId} domain=${nav.domain} kind=cross-domain-auto`);
          }
          diagLog(`[Runtime ${this.sessionId}] auto-approve tool=${toolName} requestId=${requestId}`);
          this.emitter.emitAutoApproval(requestId, toolName, 'auto');
          return { behavior: 'allow', updatedInput: input };
        }
        if (nav.kind !== 'invalid' && this.approvalMode !== 'auto') {
          const result = await this.requestToolApproval(requestId, toolName, options.toolUseID, input, {
            title: options.title,
            description: options.description,
            suggestions: options.suggestions,
            timeout: this.parseTimeout(input),
            signal: options.signal,
            decisionReasonType: options.decisionReasonType,
          });
          if (result.behavior === 'allow') {
            commitSessionNavigation(this.sessionId, nav.domain);
          }
          return result;
        }
        // nav.kind === 'invalid': fall through — the tool handler validates URLs.
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

  private wrapCanUseToolWithKimiLoopDetection(
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
        requestId: string;
      },
    ) => Promise<PermissionResult | null>,
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
      requestId: string;
    },
  ) => Promise<PermissionResult | null> {
    return async (toolName, input, options) => {
      const action = this.kimiLoopDetector!.beforeToolUse(toolName, input);
      if (action.behavior === 'deny') {
        diagLog(`[Runtime ${this.sessionId}] kimi-loop deny tool=${toolName} toolUseId=${options.toolUseID}`);
        return { behavior: 'deny', message: action.message };
      }
      return baseCanUseTool(toolName, input, options);
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
    this.evaluateProcessingEdge();
    pending.resolve({
      behavior: 'deny',
      message: 'Request timed out waiting for user response.',
    });
  }

  /**
   * timeoutDeny semantics for server-side timers that own their own clock
   * (U5 browser handoff, KTD-6): the handoff controller's fixed 10-minute
   * timer fires this so the pending card emits approval_timeout and resolves
   * as a recoverable deny — identical to an input-driven timeout. No-op when
   * the requestId is not pending.
   */
  timeoutDenyApproval(requestId: string): void {
    this.timeoutDeny(requestId);
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
    // Force-emit the current processing verdict after replay and the
    // approval re-emit: a fresh subscriber mid background-only task has no
    // currentMessageStartId-anchored replay to restore the spinner from.
    this.forceEmitSessionProcessing();
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
    // Force-emit after replay so the current verdict wins over any stale
    // session_processing event in the ring buffer.
    this.forceEmitSessionProcessing();
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

  unsubscribeWebSocket(handler: (id: number, event: SseEvent) => void): void {
    this.removeWebEventHandler(handler);
    // Only tear down SSE heartbeat/response state when no SSE response is
    // active and no web handlers remain. This keeps a runtime alive for a
    // sibling SSE subscriber when a WebSocket client disconnects.
    if (this.activeRes || this.webEventHandlers.size > 0) {
      return;
    }
    this.unsubscribe();
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

  /**
   * Session-wide processing predicate: a foreground turn is streaming, a
   * tool approval is pending, OR confirmed background tasks are still
   * running (R1). Despite the historical name this is broader than a turn —
   * use `isTurnActive()` for turn-only semantics (bot /stop gates).
   */
  isProcessingTurn(): boolean {
    return (
      this.currentMessageStartId !== undefined ||
      this.pendingApprovals.size > 0 ||
      this.confirmedBackgroundTasks.size > 0
    );
  }

  /**
   * Turn-only predicate: a foreground turn is streaming or blocked on a
   * pending approval. Background tasks do not count — bots use this for
   * their turn-scoped /stop semantics.
   */
  isTurnActive(): boolean {
    return this.currentMessageStartId !== undefined || this.pendingApprovals.size > 0;
  }

  /**
   * Fold a directional task signal from the emitter into the background-task
   * tracker. Only confirmed-background signals (asyncLaunched /
   * bashBackgrounded / backgroundedPatch) grant membership; a bare
   * task_started creates an unconfirmed candidate (R2), and skip_transcript
   * tasks never enter the tracker at all (R3).
   */
  private handleTaskSignal(signal: TaskSignal): void {
    switch (signal.kind) {
      case 'started': {
        diagLog(
          `[Runtime ${this.sessionId}] task_started taskId=${signal.taskId} toolUseId=${signal.toolUseId ?? 'none'} subagentType=${signal.subagentType ?? 'none'} skipTranscript=${signal.skipTranscript === true}`,
        );
        if (signal.skipTranscript) {
          this.rememberSkippedTask(signal.taskId);
          return;
        }
        if (this.terminatedTaskIds.has(signal.taskId)) return;
        this.taskCandidates.set(signal.taskId, {
          ...(signal.toolUseId !== undefined && { toolUseId: signal.toolUseId }),
        });
        if (signal.toolUseId && this.pendingConfirmations.has(signal.toolUseId)) {
          this.pendingConfirmations.delete(signal.toolUseId);
          this.confirmBackgroundTask(signal.taskId);
          return;
        }
        // Reverse of the asyncLaunched single-candidate fallback: an unkeyed
        // task_started can consume a parked confirmation only when the match
        // is unambiguous — exactly one pending confirmation and this task is
        // the sole candidate lacking a toolUseId.
        if (signal.toolUseId === undefined && this.pendingConfirmations.size === 1) {
          let unkeyedCandidates = 0;
          for (const candidate of this.taskCandidates.values()) {
            if (candidate.toolUseId === undefined) unkeyedCandidates++;
          }
          if (unkeyedCandidates === 1) {
            const [toolUseId] = this.pendingConfirmations;
            this.pendingConfirmations.delete(toolUseId);
            this.confirmBackgroundTask(signal.taskId);
          }
        }
        return;
      }
      case 'asyncLaunched': {
        for (const [taskId, candidate] of this.taskCandidates) {
          if (candidate.toolUseId === signal.toolUseId) {
            this.confirmBackgroundTask(taskId);
            return;
          }
        }
        // Single-candidate fallback: an uncorrelated asyncLaunched confirms
        // the sole candidate when it carries no toolUseId of its own. With
        // two or more candidates there is no safe guess.
        if (this.taskCandidates.size === 1) {
          const [[taskId, candidate]] = this.taskCandidates;
          if (candidate.toolUseId === undefined) {
            this.confirmBackgroundTask(taskId);
            return;
          }
        }
        this.pendingConfirmations.add(signal.toolUseId);
        return;
      }
      case 'bashBackgrounded':
      case 'backgroundedPatch': {
        this.confirmBackgroundTask(signal.taskId);
        return;
      }
      case 'terminal': {
        this.taskCandidates.delete(signal.taskId);
        this.confirmedBackgroundTasks.delete(signal.taskId);
        this.rememberTerminatedTask(signal.taskId);
        this.evaluateProcessingEdge();
        return;
      }
    }
  }

  private confirmBackgroundTask(taskId: string): void {
    if (this.skippedTaskIds.has(taskId)) {
      // R3: ambient (skip_transcript) tasks never enter the tracked set,
      // even when a later backgrounded signal names them.
      return;
    }
    if (this.terminatedTaskIds.has(taskId)) {
      // Ghost guard: a confirmation arriving after the terminal signal must
      // not resurrect a finished task and pin the session forever.
      return;
    }
    this.taskCandidates.delete(taskId);
    this.confirmedBackgroundTasks.add(taskId);
    this.evaluateProcessingEdge();
  }

  private rememberTerminatedTask(taskId: string): void {
    this.terminatedTaskIds.add(taskId);
    while (this.terminatedTaskIds.size > TERMINATED_TASK_IDS_CAP) {
      const oldest = this.terminatedTaskIds.values().next().value;
      if (oldest === undefined) break;
      this.terminatedTaskIds.delete(oldest);
    }
  }

  private rememberSkippedTask(taskId: string): void {
    this.skippedTaskIds.add(taskId);
    while (this.skippedTaskIds.size > SKIPPED_TASK_IDS_CAP) {
      const oldest = this.skippedTaskIds.values().next().value;
      if (oldest === undefined) break;
      this.skippedTaskIds.delete(oldest);
    }
  }

  /**
   * Single emission path for the processing verdict: emit only on a flip.
   * Every mutation site (message loop, approvals, interrupt, tracker) calls
   * this after mutating so all edges share one code path.
   */
  private evaluateProcessingEdge(): void {
    const next = this.isProcessingTurn();
    const count = this.confirmedBackgroundTasks.size;
    if (next !== this.lastEmittedProcessing || count !== this.lastEmittedBackgroundTaskCount) {
      this.lastEmittedProcessing = next;
      this.lastEmittedBackgroundTaskCount = count;
      this.emitter.emitSessionProcessing(next, count);
    }
  }

  /**
   * Hydration path for fresh subscribers: emit the current verdict even when
   * it has not flipped, and record it so future edges still fire on change.
   */
  private forceEmitSessionProcessing(): void {
    const processing = this.isProcessingTurn();
    const count = this.confirmedBackgroundTasks.size;
    this.lastEmittedProcessing = processing;
    this.lastEmittedBackgroundTaskCount = count;
    this.emitter.emitSessionProcessing(processing, count);
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
    this.kimiLoopDetector?.reset();
    this.onActivity?.();
  }

  resolveApproval(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.clearPendingTimer(pending);
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);
    this.evaluateProcessingEdge();

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
      this.evaluateProcessingEdge();

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
            this.evaluateProcessingEdge();
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
      this.evaluateProcessingEdge();
    } catch (err) {
      console.error('Interrupt failed:', err);
      this.emitter.emitErrorNote(
        `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * One-click clear-all (R8, KTD-5): interrupt the in-flight turn if any,
   * then stop every tracked background task. Failure-isolated and never
   * throws: a throwing interrupt must not skip the task loop, and a rejected
   * stopTask only logs and leaves its task tracked until its own terminal
   * signal (or runtime close) arrives.
   */
  async stopAll(): Promise<void> {
    // Snapshot: a task confirmed after this point is not stopped (accepted
    // documented semantics).
    const taskIds = [...this.confirmedBackgroundTasks];

    if (this.isTurnActive()) {
      try {
        await this.interrupt();
      } catch (err) {
        // interrupt() has already emitted its error note; swallow the rethrow
        // so the task loop still runs.
        diagLog(
          `[Runtime ${this.sessionId}] stopAll: interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const results = await Promise.allSettled(
      taskIds.map((taskId) => this.query.stopTask(taskId)),
    );
    results.forEach((result, index) => {
      const taskId = taskIds[index];
      if (result.status === 'fulfilled') {
        // The SDK documents a terminal `stopped` notification (the R9 path);
        // untracking here through the same terminal path is an idempotent
        // safety net in case that notification is ever dropped, and emits
        // edges exactly the way the notification would.
        this.handleTaskSignal({ kind: 'terminal', taskId });
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        diagLog(`[Runtime ${this.sessionId}] stopAll: stopTask(${taskId}) failed: ${reason}`);
      }
    });
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
    this.evaluateProcessingEdge();
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
    // Resolve any dangling pending approvals so their Promises don't leak
    // (ahead of the final verdict so it reflects a fully idle session).
    for (const [requestId, pending] of this.pendingApprovals) {
      this.clearPendingTimer(pending);
      pending.resolve({
        behavior: 'deny',
        message: `Session closed while waiting for approval: ${requestId}`,
      });
    }
    this.pendingApprovals.clear();
    // The runtime is dead: reconcile the tracker one last time so attached
    // subscribers receive a final {processing:false, backgroundTaskCount:0}
    // verdict before they are detached. The edge guard suppresses the
    // emission when the loop-death reconciliation already shipped it.
    this.taskCandidates.clear();
    this.confirmedBackgroundTasks.clear();
    this.evaluateProcessingEdge();
    this.unsubscribe();
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
