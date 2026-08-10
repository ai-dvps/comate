import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  Query,
  SDKRateLimitInfo,
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SseEvent,
  QuestionPayload,
  PermissionSuggestion,
  SessionActivitySnapshot,
  SessionActivityInterruption,
  SessionBackgroundTask,
} from '../types/message.js';
import type { ApprovalMode } from '../models/session.js';
import type { Provider } from '../models/provider.js';
import type { BotEscalationAudience } from '../storage/sqlite-store.js';
import type { McpToolAnnotations } from './mcp-tool-classification.js';
import { PushableIterator } from './pushable-iterator.js';
import { SseEmitter } from './sse-emitter.js';
import { SdkClient } from './sdk-client.js';
import { ClaudeBackendDriver, type BackendDriver } from './backend-driver.js';
import { diagLog } from '../utils/diag-logger.js';
import { KimiLoopDetector, isKimiProvider } from './kimi-loop-detector.js';
import { BROWSER_TOOL_NAMES } from './browser-tool-names.js';
import {
  commitSessionNavigation,
  evaluateSessionNavigation,
  isBrowserSubmitClassified,
  redactSubmitGateInput,
} from './browser-gate-state.js';
import { browserAuditService } from './browser-audit.js';


const RING_BUFFER_CAP = 500;
const STOP_DRAIN_TIMEOUT_MS = 2000;
const BACKGROUND_TASK_STOP_TIMEOUT_MS = 10_000;

/**
 * Deny message produced when an approval TTL expires (timeoutDeny). Exported
 * so the U6 audit layer distinguishes `sandbox_escape_expired` from a human
 * denial without string-sniffing a magic literal at two sites.
 */
export const APPROVAL_TIMEOUT_DENY_MESSAGE = 'Request timed out waiting for user response.';
diagLog('[SessionRuntime] module loaded');

/**
 * Who/what settled a pending approval (U8, KTD-15): the resolving channel
 * (`self-approval` card click, `desktop` GUI route, `timeout` TTL deny; U11
 * adds remote-card sources) and, for human resolutions, the approver actor.
 * Set by resolveApproval/timeoutDeny and consumed by the bot gate's audit
 * writer so the desktop funnel and the card flow produce audit rows of
 * identical shape through the SAME provenance writer.
 */
export interface ApprovalResolutionProvenance {
  source: string;
  approver?: { type: string; channelKey?: string; channelUserId?: string };
}

function backgroundTasksEqual(
  left: readonly SessionBackgroundTask[],
  right: readonly SessionBackgroundTask[],
): boolean {
  return left.length === right.length && left.every((task, index) => {
    const other = right[index];
    return task.id === other.id && task.type === other.type && task.description === other.description;
  });
}

function activitySnapshotsEqual(
  left: SessionActivitySnapshot,
  right: SessionActivitySnapshot,
): boolean {
  if (
    left.phase !== right.phase ||
    left.active !== right.active ||
    !backgroundTasksEqual(left.backgroundTasks, right.backgroundTasks)
  ) return false;

  const leftInterruption = left.interruption;
  const rightInterruption = right.interruption;
  if (!leftInterruption || !rightInterruption) return leftInterruption === rightInterruption;
  return (
    leftInterruption.reason === rightInterruption.reason &&
    leftInterruption.message === rightInterruption.message &&
    leftInterruption.foregroundInterrupted === rightInterruption.foregroundInterrupted &&
    backgroundTasksEqual(leftInterruption.backgroundTasks, rightInterruption.backgroundTasks)
  );
}

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
  BROWSER_TOOL_NAMES.inspectElement,
  BROWSER_TOOL_NAMES.startNetworkCapture,
  BROWSER_TOOL_NAMES.stopNetworkCapture,
];

export class SessionRuntime {
  private sessionId: string;
  private workspaceId: string;
  private serverNonce: string;
  private options: Options;
  private driver: BackendDriver;
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
      suggestions?: PermissionSuggestion[];
      questions?: QuestionPayload[];
      expiresAt?: number;
      timer?: NodeJS.Timeout;
      /** U8 (KTD-15): approval audience; undefined for non-escalation pendings. */
      audience?: BotEscalationAudience;
    }
  >();
  /**
   * Resolution provenance by requestId (U8): set at resolveApproval/
   * timeoutDeny time, consumed by the gate continuation after the pending's
   * Promise settles. Bounded FIFO — pendings without a provenance consumer
   * (plain GUI approvals) would otherwise leak entries.
   */
  private resolutionProvenance = new Map<string, ApprovalResolutionProvenance>();
  private static readonly RESOLUTION_PROVENANCE_CAP = 64;
  private closed = false;
  private messageLoopPromise: Promise<void> = Promise.resolve();
  private currentMessageStartId?: string;
  private foregroundMessageUuid?: string;
  private backgroundTasks = new Map<string, SessionBackgroundTask>();
  private backgroundTaskToolUseIds = new Map<string, string>();
  private stopping = false;
  private stopFenceActive = false;
  private stopOperation?: Promise<void>;
  private resolveStopOperation?: () => void;
  private stopDeadlineTimer?: NodeJS.Timeout;
  private stopRequestedTaskIds = new Set<string>();
  private backgroundTaskStopOperations = new Map<string, Promise<boolean>>();
  private individuallyStoppedTaskIds = new Set<string>();
  private stopForegroundInterrupted = false;
  private activityInterruption?: SessionActivityInterruption;
  private lastEmittedActivity: SessionActivitySnapshot = {
    phase: 'idle',
    active: false,
    backgroundTasks: [],
  };
  private deliberateShutdown = false;
  private activeRes: Response | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private botEventHandlers = new Set<(id: number, event: SseEvent) => void>();
  private webEventHandlers = new Set<(id: number, event: SseEvent) => void>();
  private onSubscribed?: () => void;
  private onUnsubscribed?: () => void;
  private onActivity?: (activity: SessionActivitySnapshot) => void;
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
    onActivity?: (activity: SessionActivitySnapshot) => void,
    provider?: Provider,
    driver?: BackendDriver,
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
      driver,
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

  /** The backend this runtime drives (the driver's identity). */
  getBackendId(): import('./backend-driver.js').BackendDriver['backendId'] {
    return this.driver.backendId;
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
    onActivity?: (activity: SessionActivitySnapshot) => void,
    provider?: Provider,
    driver?: BackendDriver,
  ) {
    diagLog(`[Runtime ${sessionId}] constructed`);
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.serverNonce = serverNonce;
    this.input = input;
    this.options = options;
    // Backend seam (KTD-1): no driver means the built-in claude transport.
    this.driver = driver ?? new ClaudeBackendDriver(sdkClient);
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
    });
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
    this.backgroundTasks.clear();
    this.backgroundTaskToolUseIds.clear();
    this.evaluateActivity();
    const { query, messages } = this.driver.createStreamingQuery(
      this.input,
      optionsWithCallback,
    );
    this.query = query;
    this.messageLoopPromise = this.runMessageLoop(messages);
  }

  private async runMessageLoop(
    messages: AsyncGenerator<SDKMessage>,
  ): Promise<void> {
    let loopFailureMessage: string | undefined;
    try {
      for await (const msg of messages) {
        if (this.closed) break;
        this.handleActivityMessage(msg);
        if (
          (msg.type === 'stream_event' || msg.type === 'assistant') &&
          msg.parent_tool_use_id === null &&
          this.foregroundMessageUuid === undefined
        ) {
          this.foregroundMessageUuid = msg.uuid;
          this.evaluateActivity();
        }
        this.emitter.handle(msg);
        if (msg.type === 'result') {
          this.foregroundMessageUuid = undefined;
          this.evaluateActivity();
        }
      }
    } catch (err) {
      const errDetail = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack, ...(err as unknown as Record<string, unknown>) }
        : err;
      const errJson = JSON.stringify(errDetail, Object.getOwnPropertyNames(errDetail), 2);
      diagLog(`[Runtime ${this.sessionId}] message loop error: ${errJson}`);
      console.error('SessionRuntime message loop error:', err);

      const message = extractErrorMessage(err);
      loopFailureMessage = message;
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
      if (this.stopping) {
        this.hardCloseForStop(
          loopFailureMessage
            ? `SDK message stream failed during Stop: ${loopFailureMessage}`
            : 'SDK message stream ended during Stop.',
        );
      } else {
        const unfinishedForeground = this.foregroundMessageUuid !== undefined || this.pendingApprovals.size > 0;
        const unfinishedTasks = [...this.backgroundTasks.values()];
        const unexpectedlyInterrupted =
          !this.deliberateShutdown && (unfinishedForeground || unfinishedTasks.length > 0);
        this.foregroundMessageUuid = undefined;
        this.backgroundTasks.clear();
        this.backgroundTaskToolUseIds.clear();
        this.activityInterruption = unexpectedlyInterrupted
          ? {
              reason: 'runtime_failure',
              message: loopFailureMessage ?? 'SDK message stream ended unexpectedly',
              foregroundInterrupted: unfinishedForeground,
              backgroundTasks: unfinishedTasks,
            }
          : this.activityInterruption;
        this.evaluateActivity();
      }
    }
  }

  private handleActivityMessage(message: SDKMessage): void {
    if (message.type !== 'system') return;

    if (message.subtype === 'task_started') {
      if (message.tool_use_id) {
        this.backgroundTaskToolUseIds.set(message.task_id, message.tool_use_id);
      }
      return;
    }

    if (message.subtype === 'task_notification') {
      this.backgroundTaskToolUseIds.delete(message.task_id);
      return;
    }

    if (message.subtype === 'task_updated') {
      const status = message.patch.status;
      if (status && ['completed', 'failed', 'killed'].includes(status)) {
        this.backgroundTaskToolUseIds.delete(message.task_id);
      }
      return;
    }

    if (message.subtype !== 'background_tasks_changed') return;

    this.backgroundTasks = new Map(
      message.tasks.map((task) => [
        task.task_id,
        { id: task.task_id, type: task.task_type, description: task.description },
      ]),
    );
    for (const taskId of this.backgroundTaskToolUseIds.keys()) {
      if (!this.backgroundTasks.has(taskId)) {
        this.backgroundTaskToolUseIds.delete(taskId);
      }
    }
    for (const taskId of this.individuallyStoppedTaskIds) {
      if (!this.backgroundTasks.has(taskId)) {
        this.individuallyStoppedTaskIds.delete(taskId);
      }
    }
    if (this.stopFenceActive && !this.stopping && this.backgroundTasks.size > 0) {
      this.stopping = true;
      this.stopForegroundInterrupted = false;
      this.evaluateActivity();
      this.stopCurrentBackgroundTasks();
      this.hardCloseForStop('SDK reported new background work after Stop completed.');
      return;
    }
    this.evaluateActivity();
    if (this.stopping) {
      this.stopCurrentBackgroundTasks();
      this.finishGracefulStopIfDrained();
    }
  }

  private buildCanUseToolCallback() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: PermissionSuggestion[];
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
      // crossings pass with an audit row in browser_audit (U8, KTD-9).
      // Manual/readonly modes follow the generic approval flow below and
      // record the visit on approval.
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
            browserAuditService.logNavigation({
              workspaceId: this.workspaceId,
              sessionId: this.sessionId,
              domain: nav.domain,
              kind: 'first-cross-confirmed',
              outcome: 'ok',
            });
            return { behavior: 'allow', updatedInput: input };
          }
          return result;
        }
        if (nav.kind === 'allow' && this.approvalMode === 'auto') {
          commitSessionNavigation(this.sessionId, nav.domain);
          if (nav.auditCrossing) {
            browserAuditService.logNavigation({
              workspaceId: this.workspaceId,
              sessionId: this.sessionId,
              domain: nav.domain,
              kind: 'cross-domain-auto',
              outcome: 'ok',
            });
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

      // The authenticated-request broker owns its method-sensitive approval
      // inside the MCP handler. Letting the generic gate ask as well would
      // produce two cards for POST while still being bypassable by SDK allow
      // rules. The handler remains the single fail-closed authorization point.
      if (toolName === BROWSER_TOOL_NAMES.authenticatedRequest) {
        return { behavior: 'allow', updatedInput: input };
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
        suggestions?: PermissionSuggestion[];
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
      suggestions?: PermissionSuggestion[];
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
    this.rememberResolutionProvenance(requestId, { source: 'timeout' });
    this.emitter.emitApprovalTimeout(requestId);
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);
    this.evaluateActivity();
    pending.resolve({
      behavior: 'deny',
      message: APPROVAL_TIMEOUT_DENY_MESSAGE,
    });
  }

  private rememberResolutionProvenance(requestId: string, provenance: ApprovalResolutionProvenance): void {
    if (this.resolutionProvenance.size >= SessionRuntime.RESOLUTION_PROVENANCE_CAP) {
      const oldest = this.resolutionProvenance.keys().next().value;
      if (oldest !== undefined) this.resolutionProvenance.delete(oldest);
    }
    this.resolutionProvenance.set(requestId, provenance);
  }

  /**
   * Read-and-clear the resolution provenance for a settled pending (U8).
   * Called by the bot gate's audit writer after the approval Promise resolves;
   * undefined when the resolution carried no provenance (legacy callers).
   */
  consumeResolutionProvenance(requestId: string): ApprovalResolutionProvenance | undefined {
    const provenance = this.resolutionProvenance.get(requestId);
    if (provenance !== undefined) {
      this.resolutionProvenance.delete(requestId);
    }
    return provenance;
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
    const hadSubscribers = this.hasSubscribers();
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
          undefined,
          pending.audience,
        );
      }
    }
    // The current level snapshot must win over stale replayed activity.
    this.forceEmitSessionActivity();
    if (!hadSubscribers && this.hasSubscribers()) this.onSubscribed?.();
  }

  subscribeWebSocket(handler: (id: number, event: SseEvent) => void, lastEventId?: string): void {
    const hadSubscribers = this.hasSubscribers();
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
          undefined,
          pending.audience,
        );
      }
    }
    // Force-emit after replay so the current level snapshot wins.
    this.forceEmitSessionActivity();
    if (!hadSubscribers && this.hasSubscribers()) this.onSubscribed?.();
  }

  unsubscribe(res?: Response): void {
    const hadSubscribers = this.hasSubscribers();
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
    if (hadSubscribers && !this.hasSubscribers()) this.onUnsubscribed?.();
  }

  unsubscribeWebSocket(handler: (id: number, event: SseEvent) => void): void {
    const hadSubscribers = this.hasSubscribers();
    this.removeWebEventHandler(handler);
    // Only tear down SSE heartbeat/response state when no SSE response is
    // active and no web handlers remain. This keeps a runtime alive for a
    // sibling SSE subscriber when a WebSocket client disconnects.
    if (this.activeRes || this.webEventHandlers.size > 0) {
      return;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (hadSubscribers) this.onUnsubscribed?.();
  }

  hasSubscribers(): boolean {
    return this.activeRes !== null || this.webEventHandlers.size > 0;
  }

  getStatus(): {
    pendingCount: number;
    isProcessing: boolean;
    workspaceId: string;
    activity: SessionActivitySnapshot;
  } {
    const activity = this.getActivitySnapshot();
    return {
      pendingCount: this.pendingApprovals.size,
      isProcessing: activity.active,
      workspaceId: this.workspaceId,
      activity,
    };
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.query.getContextUsage();
  }

  /**
   * U9 (KTD-20): annotations for every MCP tool this session exposes, keyed
   * by the full `mcp__<server>__<tool>` name (the SDK normalizes MCP-spec
   * `readOnlyHint`/`destructiveHint` to `readOnly`/`destructive` on
   * McpServerStatus). Fail-soft: any control-channel error yields an empty
   * map — the bot gate classifies missing annotations as the unknown class
   * (fail-closed ask), never allow.
   */
  async getMcpToolAnnotations(): Promise<Map<string, McpToolAnnotations>> {
    const annotations: Map<string, McpToolAnnotations> = new Map();
    try {
      const statuses = await this.query.mcpServerStatus();
      for (const server of statuses) {
        for (const tool of server.tools ?? []) {
          annotations.set(`mcp__${server.name}__${tool.name}`, {
            ...(tool.annotations?.readOnly !== undefined && { readOnly: tool.annotations.readOnly }),
            ...(tool.annotations?.destructive !== undefined && { destructive: tool.annotations.destructive }),
          });
        }
      }
    } catch (err) {
      diagLog(
        `[Runtime ${this.sessionId}] mcpServerStatus failed: ${err instanceof Error ? err.message : String(err)} — MCP tools classify unknown`,
      );
    }
    return annotations;
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
    return this.getActivitySnapshot().active;
  }

  /**
   * Turn-only predicate: a foreground turn is streaming or blocked on a
   * pending approval. Background tasks do not count — bots use this for
   * their turn-scoped /stop semantics.
   */
  isTurnActive(): boolean {
    return this.foregroundMessageUuid !== undefined || this.pendingApprovals.size > 0;
  }

  getActivitySnapshot(): SessionActivitySnapshot {
    const backgroundTasks = [...this.backgroundTasks.values()];
    const phase = this.stopping
      ? 'stopping'
      : this.foregroundMessageUuid !== undefined || this.pendingApprovals.size > 0
        ? 'foreground'
        : backgroundTasks.length > 0
          ? 'background'
          : 'idle';
    return {
      phase,
      active: phase !== 'idle',
      backgroundTasks,
      ...(this.activityInterruption ? { interruption: this.activityInterruption } : {}),
    };
  }

  isSubagentRunning(parentToolUseId: string): boolean {
    // task_id and Agent tool_use id are separate SDK identities. Preserve the
    // task_started correlation instead of assuming an agent transcript id is
    // also the live background task id.
    for (const taskId of this.backgroundTasks.keys()) {
      if (this.backgroundTaskToolUseIds.get(taskId) === parentToolUseId) return true;
    }
    return false;
  }

  private evaluateActivity(): void {
    const next = this.getActivitySnapshot();
    if (activitySnapshotsEqual(next, this.lastEmittedActivity)) return;
    this.lastEmittedActivity = next;
    this.emitter.emitSessionActivity(next);
    this.onActivity?.(next);
  }

  private forceEmitSessionActivity(): void {
    const activity = this.getActivitySnapshot();
    this.lastEmittedActivity = activity;
    this.emitter.emitSessionActivity(activity);
  }

  cancelIdleClose(): void {
    // In the current architecture ChatService passes cancelIdleClose as onSubscribed;
    // invoking it here prevents the idle-close timer from firing while we dispatch.
    this.onSubscribed?.();
  }

  pushMessage(content: string): void {
    if (this.stopping) {
      throw new Error('Session is stopping and cannot accept new messages.');
    }
    if (this.closed) {
      throw new Error('Session is closed and cannot accept new messages.');
    }
    this.stopFenceActive = false;
    const uuid = randomUUID();
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
    };
    this.foregroundMessageUuid = uuid;
    this.activityInterruption = undefined;
    this.evaluateActivity();
    this.input.push(msg);
    this.kimiLoopDetector?.reset();
  }

  resolveApproval(requestId: string, result: PermissionResult, provenance?: ApprovalResolutionProvenance): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    if (provenance) {
      this.rememberResolutionProvenance(requestId, provenance);
    }
    this.clearPendingTimer(pending);
    this.pendingApprovals.delete(requestId);
    this.emitter.emitApprovalResolved(requestId);
    this.evaluateActivity();

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
    | { type: 'approval'; toolName?: string; toolUseId?: string; suggestions?: PermissionSuggestion[]; audience?: BotEscalationAudience }
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
      audience: pending.audience,
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
      suggestions?: PermissionSuggestion[];
      timeout?: number;
      signal?: AbortSignal;
      decisionReasonType?: string;
      /** U8 (KTD-15): escalation audience for this pending. */
      audience?: BotEscalationAudience;
    } = {},
  ): Promise<PermissionResult> {
    if (this.stopFenceActive) {
      return Promise.resolve({ behavior: 'deny', message: 'Session stopped by user.' });
    }
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
      options.audience,
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
      audience: options.audience,
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
    if (this.stopFenceActive) {
      return Promise.resolve({ behavior: 'deny', message: 'Session stopped by user.' });
    }
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
      suggestions?: PermissionSuggestion[];
      questions?: QuestionPayload[];
      expiresAt?: number;
      timer?: NodeJS.Timeout;
      signal?: AbortSignal;
      audience?: BotEscalationAudience;
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
        ...(data.audience !== undefined && { audience: data.audience }),
      });
      this.evaluateActivity();

      if (data.signal) {
        const onAbort = () => {
          const pending = this.pendingApprovals.get(requestId);
          if (pending) {
            const toolName = pending.toolName ?? 'unknown';
            const toolUseId = pending.toolUseId ?? 'none';
            diagLog(`[Runtime ${this.sessionId}] ask deny requestId=${requestId} tool=${toolName} toolUseId=${toolUseId} reason=abort`);
            this.rememberResolutionProvenance(requestId, { source: 'aborted' });
            this.clearPendingTimer(pending);
            this.pendingApprovals.delete(requestId);
            this.emitter.emitApprovalResolved(requestId);
            this.evaluateActivity();
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
      this.foregroundMessageUuid = undefined;
      this.evaluateActivity();
    } catch (err) {
      console.error('Interrupt failed:', err);
      this.emitter.emitErrorNote(
        `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  stopBackgroundTask(taskId: string): Promise<boolean> {
    if (this.driver.backendId !== 'claude') {
      return Promise.reject(
        new Error('Individual background task stopping is only supported for Claude Code sessions'),
      );
    }
    if (!this.backgroundTasks.has(taskId)) return Promise.resolve(false);

    const existing = this.backgroundTaskStopOperations.get(taskId);
    if (existing) return existing;
    if (this.individuallyStoppedTaskIds.has(taskId)) return Promise.resolve(true);

    this.individuallyStoppedTaskIds.add(taskId);
    let timeout: NodeJS.Timeout | undefined;
    const stopRequest = Promise.race([
      this.query.stopTask(taskId),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out stopping background task ${taskId}`));
        }, BACKGROUND_TASK_STOP_TIMEOUT_MS);
      }),
    ]);
    const operation = stopRequest
      .then(() => true)
      .catch((error) => {
        this.individuallyStoppedTaskIds.delete(taskId);
        if (!this.backgroundTasks.has(taskId)) return false;
        throw error;
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        this.backgroundTaskStopOperations.delete(taskId);
      });
    this.backgroundTaskStopOperations.set(taskId, operation);
    return operation;
  }

  stopAll(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    if (!this.getActivitySnapshot().active) return Promise.resolve();

    this.stopping = true;
    this.stopFenceActive = true;
    this.stopForegroundInterrupted =
      this.foregroundMessageUuid !== undefined || this.pendingApprovals.size > 0;
    this.activityInterruption = undefined;
    this.stopRequestedTaskIds.clear();
    this.evaluateActivity();
    this.stopOperation = new Promise<void>((resolve) => {
      this.resolveStopOperation = resolve;
    });
    this.stopDeadlineTimer = setTimeout(() => {
      this.hardCloseForStop('Stop deadline expired before SDK work reached zero.');
    }, STOP_DRAIN_TIMEOUT_MS);

    void this.beginStopDrain();
    return this.stopOperation;
  }

  private async beginStopDrain(): Promise<void> {
    let receipt: Awaited<ReturnType<Query['interrupt']>>;
    try {
      receipt = await this.query.interrupt();
    } catch (error) {
      this.hardCloseForStop(
        `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (!receipt || receipt.still_queued.length > 0) {
      this.hardCloseForStop(
        !receipt
          ? 'Interrupt did not return a queue receipt.'
          : `Interrupt left ${receipt.still_queued.length} queued message(s).`,
      );
      return;
    }

    this.foregroundMessageUuid = undefined;
    this.cancelPendingApprovals('Session stopped by user.');
    this.stopCurrentBackgroundTasks();
    this.finishGracefulStopIfDrained();
  }

  private stopCurrentBackgroundTasks(): void {
    for (const taskId of this.backgroundTasks.keys()) {
      if (this.stopRequestedTaskIds.has(taskId)) continue;
      this.stopRequestedTaskIds.add(taskId);
      const individualOperation = this.backgroundTaskStopOperations.get(taskId);
      if (individualOperation) {
        void individualOperation.catch((error) => {
          this.hardCloseForStop(
            `stopTask(${taskId}) failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        continue;
      }
      if (this.individuallyStoppedTaskIds.has(taskId)) continue;
      void this.query.stopTask(taskId).catch((error) => {
        this.hardCloseForStop(
          `stopTask(${taskId}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private finishGracefulStopIfDrained(): void {
    if (!this.stopping || this.foregroundMessageUuid !== undefined || this.backgroundTasks.size > 0) {
      return;
    }
    this.finishStop(false, 'Session stopped by user.');
  }

  private hardCloseForStop(message: string): void {
    if (!this.stopping) return;
    diagLog(`[Runtime ${this.sessionId}] stopAll: ${message}`);
    this.deliberateShutdown = true;
    this.closed = true;
    this.input.close();
    try {
      this.query.close();
    } catch {
      // State still settles locally when process close itself throws.
    }
    this.finishStop(true, message);
  }

  private finishStop(hardClosed: boolean, message: string): void {
    if (!this.stopping) return;
    const interruptedTasks = [...this.backgroundTasks.values()];
    if (this.stopDeadlineTimer) {
      clearTimeout(this.stopDeadlineTimer);
      this.stopDeadlineTimer = undefined;
    }
    this.cancelPendingApprovals('Session stopped by user.');
    this.foregroundMessageUuid = undefined;
    this.backgroundTasks.clear();
    this.backgroundTaskToolUseIds.clear();
    this.stopping = false;
    this.activityInterruption = {
      reason: 'user_stop',
      message: hardClosed ? message : 'Session stopped by user.',
      foregroundInterrupted: this.stopForegroundInterrupted,
      backgroundTasks: interruptedTasks,
    };
    this.emitter.emitInterrupted(null);
    this.evaluateActivity();
    const resolve = this.resolveStopOperation;
    this.resolveStopOperation = undefined;
    resolve?.();
    this.stopOperation = undefined;
    this.stopRequestedTaskIds.clear();
    this.stopForegroundInterrupted = false;
  }

  /**
   * Resolve all pending tool approvals or questions as denied. Used when a turn
   * is interrupted so the user lands in a clean state and reconnecting clients
   * do not replay stale approval cards.
   */
  cancelPendingApprovals(message = 'Turn interrupted by user.'): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      this.rememberResolutionProvenance(requestId, { source: 'stopped' });
      this.clearPendingTimer(pending);
      this.pendingApprovals.delete(requestId);
      this.emitter.emitApprovalResolved(requestId);
      pending.resolve({ behavior: 'deny', message });
    }
    this.evaluateActivity();
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
    this.deliberateShutdown = true;
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
      this.rememberResolutionProvenance(requestId, { source: 'session-closed' });
      this.clearPendingTimer(pending);
      pending.resolve({
        behavior: 'deny',
        message: `Session closed while waiting for approval: ${requestId}`,
      });
    }
    this.pendingApprovals.clear();
    // Publish one final idle snapshot before subscribers are detached. The
    // structural guard suppresses a duplicate loop-death emission.
    this.foregroundMessageUuid = undefined;
    this.backgroundTasks.clear();
    this.backgroundTaskToolUseIds.clear();
    this.stopping = false;
    this.activityInterruption = undefined;
    this.evaluateActivity();
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
