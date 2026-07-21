import { diagLog, diagWarn } from '../utils/diag-logger.js';
import {
  BrowserService,
  browserService,
  sanitizeSessionId,
  type BrowserControlState,
} from './browser-service.js';
import { browserAuditService, type BrowserAuditService } from './browser-audit.js';

/**
 * browser-control — the mutual-exclusion control state machine and the
 * handoff channel (U5, KTD-5/KTD-6). Lives in the browser-service file
 * domain: the state machine itself is keyed by chat sessionId in
 * browser-service's registry (never on a runtime — KTD-5); this service
 * DRIVES it through the handoff/takeover lifecycle and owns everything that
 * has no other home:
 *
 *  - The transition table (below) is the assertion source: rows are control
 *    states, columns are the five events, every cell has exactly one result.
 *  - The handoff lifecycle: requestHandoff's handler-body pending_approval
 *    round-trips (KTD-6 — a workspace `.claude/settings.json` allow rule can
 *    short-circuit canUseTool, so the round-trip cannot live only in the
 *    interception layer). Two sequential cards share one server-fixed
 *    10-minute timer (agent-controlled input.timeout is ignored): card #1
 *    asks for the takeover ("接管"), card #2 waits for the handback
 *    ("继续"). Keeping a card pending through the takeover is what makes the
 *    race rules work: a handoff requested while the user is already driving
 *    surfaces exactly one active card, and a crash mid-takeover still has a
 *    pending card to release.
 *  - Timeout semantics reuse the runtime's timeoutDeny (approval_timeout +
 *    recoverable deny) via an injected narrow channel — the panel's
 *    no-content activity pings reset the timer (keystrokes never travel).
 *  - Crash/runtime-close cleanup: Steel crashes arrive through
 *    browser-service's onPendingCardRelease (U1 hook, tolerates a dead
 *    runtime); runtime rebuilds arrive through chat-service's chained
 *    pre-close listener (the single-slot onRuntimeClose stays with the WS
 *    server — this service never overwrites it, KTD-5).
 */

/** Server-fixed handoff timeout (KTD-6): 10 minutes, never agent-influenced. */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;

export type BrowserControlEvent =
  | 'takeover_click'
  | 'handback_click'
  | 'timeout'
  | 'agent_tool_call'
  | 'crash';

export type BrowserTransitionEffect =
  /** No state change, no side effect. */
  | 'none'
  /** F3 proactive takeover: agent_in_control -> user_in_control, no card. */
  | 'proactive_takeover'
  /** handoff card #1 granted -> user_in_control (card #2 phase begins). */
  | 'grant_handoff'
  /** "继续" while the takeover card is still pending = decline the handoff. */
  | 'decline_handoff'
  /** Handback: user_in_control -> agent_in_control (+ state diff in the tool result). */
  | 'complete_handoff'
  /** Recoverable timeoutDeny on the pending takeover card. */
  | 'timeout_pending'
  /** Recoverable timeoutDeny on the pending handback card. */
  | 'timeout_takeover'
  /** act/submit/screenshot get a recoverable browser_user_in_control error. */
  | 'gate_tool_call'
  /** Tool calls execute normally. */
  | 'allow_tool_call'
  /** Next tool call after a crash transparently rebuilds the browser. */
  | 'rebuild'
  /** -> session_lost + the session's pending browser card is released. */
  | 'crash_release'
  /** No live browser to take over. */
  | 'reject_no_browser';

export interface BrowserTransition {
  /** Target state, or null for "stay". */
  next: BrowserControlState | null;
  effect: BrowserTransitionEffect;
}

/**
 * The control-state transition table (U5 technical design): rows are the four
 * control states, columns the five events, each cell has exactly one result.
 * Tests iterate this table directly and assert every cell through the
 * controller — the table is the assertion source, not documentation.
 */
export const BROWSER_CONTROL_TRANSITIONS: Record<
  BrowserControlState,
  Record<BrowserControlEvent, BrowserTransition>
> = {
  agent_in_control: {
    takeover_click: { next: 'user_in_control', effect: 'proactive_takeover' },
    handback_click: { next: null, effect: 'none' },
    timeout: { next: null, effect: 'none' },
    agent_tool_call: { next: null, effect: 'allow_tool_call' },
    crash: { next: 'session_lost', effect: 'crash_release' },
  },
  handoff_pending: {
    takeover_click: { next: 'user_in_control', effect: 'grant_handoff' },
    handback_click: { next: 'agent_in_control', effect: 'decline_handoff' },
    timeout: { next: 'agent_in_control', effect: 'timeout_pending' },
    agent_tool_call: { next: null, effect: 'gate_tool_call' },
    crash: { next: 'session_lost', effect: 'crash_release' },
  },
  user_in_control: {
    takeover_click: { next: null, effect: 'none' },
    handback_click: { next: 'agent_in_control', effect: 'complete_handoff' },
    timeout: { next: 'agent_in_control', effect: 'timeout_takeover' },
    agent_tool_call: { next: null, effect: 'gate_tool_call' },
    crash: { next: 'session_lost', effect: 'crash_release' },
  },
  session_lost: {
    takeover_click: { next: null, effect: 'reject_no_browser' },
    handback_click: { next: null, effect: 'none' },
    timeout: { next: null, effect: 'none' },
    agent_tool_call: { next: 'agent_in_control', effect: 'rebuild' },
    crash: { next: null, effect: 'none' },
  },
};

export type HandoffPhase = 'awaiting_takeover' | 'in_takeover';

/**
 * True when the transition table gates agent tool calls in this control state
 * (handoff_pending | user_in_control). The table is the single source of the
 * rule — the browser-mcp controlGate derives its verdict through this.
 */
export function gatesAgentToolCall(state: BrowserControlState): boolean {
  return BROWSER_CONTROL_TRANSITIONS[state].agent_tool_call.effect === 'gate_tool_call';
}

export type HandoffEndReason =
  | 'handed_back'
  | 'declined'
  | 'timeout'
  | 'crash'
  | 'runtime_closed';

export interface BrowserHandoffCompletion {
  reason: HandoffEndReason;
  /** Phase the handoff had reached when it ended (drives the state diff). */
  phase?: HandoffPhase;
  detail?: string;
}

export interface BrowserHandoffHandle {
  readonly sessionId: string;
  readonly reason: string;
  readonly phase: HandoffPhase;
  readonly startedAt: number;
}

export interface BrowserHandoffInfo {
  sessionId: string;
  reason: string;
  phase: HandoffPhase;
  startedAt: number;
  /** Live approval-card requestId (card #1 or card #2), if one is pending. */
  cardRequestId: string | null;
}

export type BrowserHandoffErrorCode =
  | 'browser_handoff_already_pending'
  | 'browser_no_session'
  | 'browser_session_lost';

export class BrowserHandoffError extends Error {
  constructor(
    readonly code: BrowserHandoffErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserHandoffError';
  }
}

export interface BrowserVerbResult {
  ok: boolean;
  code?: BrowserHandoffErrorCode;
  message?: string;
}

/** Narrow runtime channel for the two card verbs — tolerates a dead runtime. */
export type ApprovalCardResolver = (
  sessionId: string,
  requestId: string,
  result: 'allow' | 'deny',
  message?: string,
) => void;
/** timeoutDeny semantics on a live card (approval_timeout + recoverable deny). */
export type ApprovalCardTimeout = (sessionId: string, requestId: string) => void;

export interface BrowserControlTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface BrowserControlDeps {
  browserService: BrowserService;
  resolveApprovalCard?: ApprovalCardResolver;
  timeoutApprovalCard?: ApprovalCardTimeout;
  now?: () => number;
  /** Server-fixed (KTD-6). Injectable for tests; agent input never sets it. */
  handoffTimeoutMs?: number;
  timer?: BrowserControlTimer;
  /** Audit sink for control-plane events (U8); defaults to the singleton. */
  audit?: Pick<BrowserAuditService, 'logControl'>;
}

interface HandoffRecord {
  sessionId: string;
  reason: string;
  phase: HandoffPhase;
  cardRequestId: string | null;
  cardCounter: number;
  startedAt: number;
  timerHandle: unknown | null;
  /** Set by controller-driven endings BEFORE the card resolves, so the
   * handler can classify the deny it is about to receive. */
  endedBy: HandoffEndReason | null;
}

const defaultTimer: BrowserControlTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class BrowserControlService {
  private deps: BrowserControlDeps & { now: () => number; handoffTimeoutMs: number; timer: BrowserControlTimer; audit: Pick<BrowserAuditService, 'logControl'> };
  private readonly records = new Map<string, HandoffRecord>();

  constructor(deps: BrowserControlDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      handoffTimeoutMs: deps.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
      timer: deps.timer ?? defaultTimer,
      audit: deps.audit ?? browserAuditService,
    };
    // Crash path (KTD-5): a dying Steel process releases this session's
    // pending browser card through the U1 registry hook. Tolerates the
    // runtime already being gone — the resolver injection no-ops then.
    this.deps.browserService.onPendingCardRelease((sessionId) => {
      this.handleCrashRelease(sessionId);
    });
  }

  /**
   * Late-binding for the singleton: chat-service wires the runtime channel at
   * construction time (the runtime map lives there). Idempotent — last wins.
   */
  configureRuntimeChannel(channel: {
    resolveApprovalCard: ApprovalCardResolver;
    timeoutApprovalCard: ApprovalCardTimeout;
  }): void {
    this.deps.resolveApprovalCard = channel.resolveApprovalCard;
    this.deps.timeoutApprovalCard = channel.timeoutApprovalCard;
  }

  getHandoff(sessionId: string): BrowserHandoffInfo | undefined {
    const record = this.records.get(sessionId);
    if (!record) return undefined;
    return {
      sessionId: record.sessionId,
      reason: record.reason,
      phase: record.phase,
      startedAt: record.startedAt,
      cardRequestId: record.cardRequestId,
    };
  }

  // -------------------------------------------------------------------------
  // Panel verbs (server semantics for the U6 state bar).
  // -------------------------------------------------------------------------

  /** 接管点击 — F3 proactive takeover, or granting a pending handoff card. */
  takeover(sessionId: string): BrowserVerbResult {
    const state = this.deps.browserService.getControlState(sessionId);
    if (!state) {
      return {
        ok: false,
        code: 'browser_no_session',
        message: 'This chat session has no browser yet — there is nothing to take over.',
      };
    }
    const cell = BROWSER_CONTROL_TRANSITIONS[state].takeover_click;
    switch (cell.effect) {
      case 'proactive_takeover':
        this.deps.browserService.setControlState(sessionId, 'user_in_control', 'user_takeover');
        diagLog(`[browser-control] proactive takeover session=${sessionId}`);
        this.logControl(sessionId, 'takeover', 'ok', 'proactive');
        return { ok: true };
      case 'grant_handoff': {
        // Resolving card #1 allow is the takeover grant; the handoff handler's
        // continuation performs the state flip (single flip path).
        const record = this.records.get(sessionId);
        if (record?.cardRequestId) {
          this.deps.resolveApprovalCard?.(sessionId, record.cardRequestId, 'allow');
        } else {
          // Defensive: a record without a live card keeps the machine moving.
          this.deps.browserService.setControlState(sessionId, 'user_in_control', 'handoff_granted');
        }
        diagLog(`[browser-control] handoff granted via takeover verb session=${sessionId}`);
        this.logControl(sessionId, 'handoff_granted', 'ok');
        return { ok: true };
      }
      case 'reject_no_browser':
        return {
          ok: false,
          code: 'browser_session_lost',
          message:
            'The browser session was lost. The next agent tool call rebuilds it; takeover is available again afterwards.',
        };
      case 'none':
      default:
        return { ok: true };
    }
  }

  /** 继续点击 — hand control back (completing a handoff when one is active). */
  handback(sessionId: string): BrowserVerbResult {
    const state = this.deps.browserService.getControlState(sessionId);
    if (!state) {
      return {
        ok: false,
        code: 'browser_no_session',
        message: 'This chat session has no browser session to hand back.',
      };
    }
    const cell = BROWSER_CONTROL_TRANSITIONS[state].handback_click;
    switch (cell.effect) {
      case 'complete_handoff': {
        const record = this.records.get(sessionId);
        if (record) {
          // Card #2's allow IS the handback — the handler computes the state
          // diff and flips the state when its round-trip resolves.
          if (record.cardRequestId) {
            this.deps.resolveApprovalCard?.(sessionId, record.cardRequestId, 'allow');
          } else {
            record.endedBy = 'handed_back';
          }
        } else {
          // F3 proactive takeover: no card pending — flip directly.
          this.deps.browserService.setControlState(sessionId, 'agent_in_control', 'user_handback');
        }
        diagLog(`[browser-control] handback session=${sessionId}`);
        this.logControl(sessionId, 'handback', 'ok', record ? undefined : 'proactive');
        return { ok: true };
      }
      case 'decline_handoff': {
        // "继续" before taking over = decline the handoff: the agent carries on.
        const record = this.records.get(sessionId);
        if (record?.cardRequestId) {
          record.endedBy = 'declined';
          this.deps.resolveApprovalCard?.(
            sessionId,
            record.cardRequestId,
            'deny',
            'The user continued without taking over.',
          );
        }
        diagLog(`[browser-control] handoff declined via handback verb session=${sessionId}`);
        this.logControl(sessionId, 'handback', 'ok', 'declines-handoff');
        return { ok: true };
      }
      case 'none':
      default:
        return { ok: true };
    }
  }

  /**
   * Panel activity ping (KTD-6): content-free — only the timer is reset;
   * keystrokes or page data never travel on this channel. Deliberately NOT
   * audited: a ping carries zero information (~40 rows per 10-minute handoff
   * would be pure churn in browser_audit).
   *
   * Also resets the idle-reclaim timer (U3) — a human actively driving the
   * pane is not idle. Fires before the handoff-record gate so it resets even
   * outside an active handoff.
   */
  recordActivity(sessionId: string): void {
    this.deps.browserService.resetIdle(sessionId);
    const record = this.records.get(sessionId);
    if (!record || record.timerHandle === null) return;
    this.clearTimer(record);
    this.armTimer(record);
  }

  /**
   * Control-plane audit (U8, KTD-9): workspaceId resolves through the
   * browser registry (the audit row is dropped silently for unknown
   * sessions — audit must never break a control flow).
   */
  private logControl(
    sessionId: string,
    verb: string,
    outcome: 'ok' | 'denied' | 'error' | 'timeout',
    detail?: string,
  ): void {
    const workspaceId = this.deps.browserService.getWorkspaceId(sessionId);
    if (!workspaceId) return;
    this.deps.audit.logControl({ workspaceId, sessionId, verb, outcome, ...(detail !== undefined && { detail }) });
  }

  // -------------------------------------------------------------------------
  // Handoff lifecycle (driven by the requestHandoff tool handler, KTD-6).
  // -------------------------------------------------------------------------

  /**
   * Open a handoff for the session. Flips agent_in_control -> handoff_pending
   * (a handoff requested while the user is already driving — F3 race — keeps
   * user_in_control and starts directly in the handback phase, so its card is
   * the single active card). Arms the server-fixed 10-minute timer.
   */
  beginHandoff(sessionId: string, reason: string): BrowserHandoffHandle {
    if (this.records.has(sessionId)) {
      throw new BrowserHandoffError(
        'browser_handoff_already_pending',
        'A handoff is already pending for this session; wait for it to complete.',
      );
    }
    const state = this.deps.browserService.getControlState(sessionId);
    if (!state) {
      throw new BrowserHandoffError(
        'browser_no_session',
        'No browser session exists for this chat session.',
      );
    }
    if (state === 'handoff_pending') {
      throw new BrowserHandoffError(
        'browser_handoff_already_pending',
        'A handoff is already pending for this session; wait for it to complete.',
      );
    }
    if (state === 'session_lost') {
      throw new BrowserHandoffError(
        'browser_session_lost',
        'The browser session was lost; retry the tool call to rebuild it first.',
      );
    }
    const record: HandoffRecord = {
      sessionId,
      reason,
      phase: state === 'user_in_control' ? 'in_takeover' : 'awaiting_takeover',
      cardRequestId: null,
      cardCounter: 0,
      startedAt: this.deps.now(),
      timerHandle: null,
      endedBy: null,
    };
    this.records.set(sessionId, record);
    if (state === 'agent_in_control') {
      this.deps.browserService.setControlState(sessionId, 'handoff_pending', 'handoff_requested');
    }
    this.armTimer(record);
    diagLog(`[browser-control] handoff begun session=${sessionId} phase=${record.phase}`);
    this.logControl(sessionId, 'handoff_requested', 'ok', record.phase);
    return {
      sessionId: record.sessionId,
      reason: record.reason,
      phase: record.phase,
      startedAt: record.startedAt,
    };
  }

  /**
   * Mint and register the next approval card's requestId. Returns null when
   * the handoff was ended between phases (crash/runtime close with no live
   * card) — the handler then finishes with the recorded ending.
   */
  beginCard(sessionId: string): string | null {
    const record = this.records.get(sessionId);
    if (!record) return null;
    if (record.endedBy) return null;
    record.cardCounter += 1;
    record.cardRequestId = `browser-handoff-${sanitizeSessionId(sessionId)}-${record.cardCounter}`;
    return record.cardRequestId;
  }

  /** Card #1 granted: flip to the takeover phase (state -> user_in_control). */
  noteTakeoverApproved(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.phase = 'in_takeover';
    record.cardRequestId = null;
    this.deps.browserService.setControlState(sessionId, 'user_in_control', 'handoff_granted');
    diagLog(`[browser-control] takeover approved session=${sessionId}`);
  }

  /**
   * Classify a deny the handler just received: controller-driven endings
   * (timeout/crash/runtime close) marked the record first; anything else is a
   * user decline (or an SDK abort, which surfaces as a decline — the turn is
   * ending either way).
   */
  classifyDeny(sessionId: string): HandoffEndReason {
    return this.records.get(sessionId)?.endedBy ?? 'declined';
  }

  /** The controller-recorded ending, when one was driven externally. */
  endedReason(sessionId: string): HandoffEndReason | undefined {
    return this.records.get(sessionId)?.endedBy ?? undefined;
  }

  /**
   * Close out the handoff: clear the timer, drop the record, and flip the
   * state machine back per the transition table. Never overrides
   * session_lost (the crash path owns that state).
   */
  completeHandoff(sessionId: string, reason: HandoffEndReason): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    this.clearTimer(record);
    this.records.delete(sessionId);
    const state = this.deps.browserService.getControlState(sessionId);
    if (state !== 'handoff_pending' && state !== 'user_in_control') return;
    this.deps.browserService.setControlState(sessionId, 'agent_in_control', this.eventReasonFor(reason));
    diagLog(`[browser-control] handoff completed session=${sessionId} reason=${reason}`);
    const outcome =
      reason === 'handed_back' ? 'ok' : reason === 'timeout' ? 'timeout' : reason === 'declined' ? 'denied' : 'error';
    this.logControl(sessionId, `handoff_${reason}`, outcome);
  }

  /**
   * Runtime-close hook (chained pre-close listener in chat-service — the WS
   * server's single-slot onRuntimeClose is never touched, KTD-5). Marks the
   * ending BEFORE runtime.close() resolves the live card with its generic
   * "session closed" deny, so the handler classifies it as runtime_closed.
   * The browser itself survives — the state flips back to agent_in_control.
   */
  handleRuntimeClosing(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.endedBy = 'runtime_closed';
    this.clearTimer(record);
    if (!record.cardRequestId) {
      // Between phases: no card for the runtime to resolve — finish here.
      this.completeHandoff(sessionId, 'runtime_closed');
    }
  }

  private handleCrashRelease(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.endedBy = 'crash';
    this.clearTimer(record);
    if (record.cardRequestId) {
      // Release the hanging card (KTD-5 — tolerates a dead runtime; the
      // handler's deny continuation completes the handoff). browser-service
      // owns the session_lost flip.
      this.deps.resolveApprovalCard?.(
        sessionId,
        record.cardRequestId,
        'deny',
        'The browser process crashed during the handoff.',
      );
    } else {
      this.completeHandoff(sessionId, 'crash');
    }
  }

  private armTimer(record: HandoffRecord): void {
    record.timerHandle = this.deps.timer.set(() => {
      this.handleTimeout(record.sessionId);
    }, this.deps.handoffTimeoutMs);
  }

  private clearTimer(record: HandoffRecord): void {
    if (record.timerHandle !== null) {
      this.deps.timer.clear(record.timerHandle);
      record.timerHandle = null;
    }
  }

  /** Server-fixed 10-minute timeout (KTD-6): timeoutDeny on the live card. */
  private handleTimeout(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.timerHandle = null;
    const state = this.deps.browserService.getControlState(sessionId);
    if (!state) {
      this.completeHandoff(sessionId, 'timeout');
      return;
    }
    const cell = BROWSER_CONTROL_TRANSITIONS[state].timeout;
    if (cell.effect !== 'timeout_pending' && cell.effect !== 'timeout_takeover') {
      // No active phase timer should exist in this state — expire quietly.
      diagWarn(`[browser-control] handoff timer fired in state ${state} session=${sessionId}; ignoring`);
      return;
    }
    record.endedBy = 'timeout';
    diagLog(`[browser-control] handoff timeout session=${sessionId} phase=${record.phase}`);
    if (record.cardRequestId) {
      // timeoutDeny semantics (approval_timeout + recoverable deny); the
      // handler's continuation completes the handoff and flips the state.
      this.deps.timeoutApprovalCard?.(sessionId, record.cardRequestId);
    } else {
      this.completeHandoff(sessionId, 'timeout');
    }
  }

  private eventReasonFor(reason: HandoffEndReason): string {
    switch (reason) {
      case 'handed_back':
        return 'user_handback';
      case 'declined':
        return 'handoff_declined';
      case 'timeout':
        return 'handoff_timeout';
      case 'runtime_closed':
        return 'runtime_closed';
      case 'crash':
        return 'crash';
    }
  }
}

export const browserControlService = new BrowserControlService({ browserService });
