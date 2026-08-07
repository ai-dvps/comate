import { randomBytes } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { getStorageDir } from '../storage/data-dir.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import type { BrowserSessionContext, BrowserSiteAuthEntry } from '../models/workspace.js';
import {
  CdpConnection,
  connectBrowserPage,
  createShellTarget,
  exportCdpSessionContext,
  fetchCdpBrowserInfo,
  findCdpTargetIdByMarker,
  retryDuringColdStart,
} from './browser-cdp.js';
import { resolveBrowserCdpTarget, type BrowserCdpTarget } from './browser-target.js';
import {
  ControlChannelError,
  ShellControlClient,
  ShellViewHandle,
  type ShellViewEvent,
} from './browser-shell-client.js';
import { siteKeyForUrl } from './browser-site-key.js';
import { clearBrowserGateSession } from './browser-gate-state.js';
import {
  decodeSiteAuthEntry,
  filterContextToScope,
  readGlobalSiteAuthEntry,
  readSiteAuthEntry,
} from './browser-site-auth.js';
import { browserAuditService, type BrowserAuditService } from './browser-audit.js';
import {
  BrowserAuthBindingError,
  BrowserAuthBindingVault,
  type CapturedAuthMaterial,
  type ResolvedAuthMaterial,
} from './browser-auth-binding.js';

/**
 * browser-service — native browser session lifecycle (KTD-1, KTD-5). One
 * shell-hosted browser view per active chat session, keyed by chat sessionId —
 * deliberately NOT attached to a runtime or SDK MCP server instance: runtime
 * rebuilds (provider switch, bot policy change, idle close) rebind to the
 * existing browser by sessionId (KTD-5). `forkSession` mints a new sessionId,
 * so a forked chat cold-starts its own browser (KTD-1).
 *
 * The browser itself lives in the Electron shell (per-session partition view
 * created over the KTD-11 control channel) or in an operator-supplied external
 * debug-port Chromium (COMATE_BROWSER_CDP_TARGET — the R8/AE2 fallback, U9
 * decision: no client re-release needed, aimed at support/enterprise-ops
 * scenarios). U9 removed the bundled child-process stack end to end; there is
 * no Chromium resolution, no profile dirs, and no pidfiles on this path —
 * session/workspace deletion wipes the shell partition (KTD-11), and orphan
 * partitions are reconciled against the session registry at startup.
 *
 * Control state machine lives here (KTD-5): agent_in_control |
 * user_in_control | handoff_pending (+ session_lost transient). U5 owns the
 * handoff/approval flows; this unit owns the registry, transitions, and
 * crash recovery.
 *
 * Teardown hooks (KTD-1) are exposed as explicit entry points because session
 * deletion does not close runtimes and `onRuntimeClose` is a single-slot
 * callback already owned by the WS server (KTD-5 — this service never
 * overwrites it; its own listener APIs are chainable multi-listener):
 *  - session delete              -> teardownSession(sessionId)
 *  - workspace delete cascade    -> teardownWorkspace(workspaceId)
 *  - sidecar shutdown (2s budget)-> shutdown()
 */

export type BrowserControlState =
  | 'agent_in_control'
  | 'user_in_control'
  | 'handoff_pending'
  | 'session_lost';

export type BrowserUnavailableCode =
  | 'browser_limit_reached'
  | 'browser_start_failed';

export class BrowserUnavailableError extends Error {
  constructor(
    readonly code: BrowserUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

export type BrowserSiteAuthErrorCode =
  | 'browser_no_session'
  | 'browser_no_page'
  | 'ip_literal'
  | 'invalid_url'
  | 'empty_context'
  | 'export_failed';

/** Typed remember-flow failure — the WS verb maps these to user-facing copy. */
export class BrowserSiteAuthError extends Error {
  constructor(
    readonly code: BrowserSiteAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSiteAuthError';
  }
}

export interface RememberSiteResult {
  key: string;
  origin: string;
  cookieCount: number;
  storageDomainCount: number;
}

export interface SiteAuthInjection {
  key: string;
  context: BrowserSessionContext;
}

export interface BrowserSessionInfo {
  sessionId: string;
  workspaceId: string;
  state: BrowserControlState;
  port: number;
  pid: number | undefined;
  baseUrl: string;
  userDataDir: string;
  startedAt: number;
}

export interface BrowserStateEvent {
  type: 'browser_state';
  sessionId: string;
  workspaceId: string;
  state: BrowserControlState;
  port?: number;
  reason?: string;
}

export interface BrowserClosedEvent {
  type: 'browser_closed';
  sessionId: string;
  workspaceId: string;
}

export interface BrowserUnavailableEvent {
  type: 'browser_unavailable';
  sessionId: string;
  workspaceId: string;
  code: BrowserUnavailableCode;
  reason: string;
}

/**
 * Idle-reclaim prompt (U3): emitted when the idle duration elapses
 * (`pending: true`, the client shows the "close now / not now" banner) and
 * again when the prompt is dismissed by activity or a snooze (`pending: false`).
 */
export interface BrowserIdlePromptEvent {
  type: 'browser_idle_prompt';
  sessionId: string;
  workspaceId: string;
  pending: boolean;
  /** Present with `pending: true`: how long the browser sat idle. */
  idleForMs?: number;
}

export type BrowserServiceEvent =
  | BrowserStateEvent
  | BrowserClosedEvent
  | BrowserUnavailableEvent
  | BrowserIdlePromptEvent;

export type BrowserEventListener = (event: BrowserServiceEvent) => void;
export type PendingCardReleaser = (sessionId: string) => void;

export const DEFAULT_MAX_BROWSER_SESSIONS = 4;

/** Server-fixed idle duration before the close prompt fires (U3); default 15 min. */
export const DEFAULT_IDLE_PROMPT_MS = 15 * 60 * 1000;
/** Server-fixed grace after the prompt before auto-close (U3); default 30 min. */
export const DEFAULT_IDLE_CLOSE_MS = 30 * 60 * 1000;

/**
 * Injectable timer for the idle-reclaim deadlines (U3), mirroring
 * BrowserControlTimer. Default uses setTimeout; tests inject a deterministic
 * fake so they never wait on real time.
 */
export interface BrowserServiceTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** Trigger source for an explicit close (U1) — recorded in the audit verb. */
export type BrowserCloseSource = 'agent' | 'human' | 'idle' | 'timeout';

/** Result of closeSession: whether teardown ran. */
export interface CloseSessionResult {
  closed: boolean;
}

interface RegistryEntry {
  sessionId: string;
  workspaceId: string;
  state: BrowserControlState;
  handle: ShellViewHandle | null;
  starting: Promise<BrowserSessionInfo> | null;
  /** External-CDP targetDestroyed watcher teardown (R8 fallback path). */
  closeWatcher?: (() => void) | undefined;
  /** Set when teardown is in flight so an exit is not treated as a crash. */
  expectingExit: boolean;
  startedAt: number;
  /**
   * Per-session CSPRNG token, minted once per registry entry and used as the
   * view's CDP marker (`about:blank#comate-view-<token>` — how the sidecar
   * finds the fresh view's target on the debug port). Survives crash rebuilds
   * (the entry persists across session_lost); dies with the entry on
   * teardown.
   */
  viewerToken: string;
  /**
   * One-shot remembered-site injection eligibility (U8): set on every
   * successful (re)spawn, consumed by the first open() — injection happens
   * exactly once per view, before the first navigation.
   */
  siteAuthEligible: boolean;
  /** Idle-reclaim (U3): timestamp of the last browser activity (agent tool call or human ping). */
  lastActivityAt: number;
  /** Idle-reclaim (U3): non-null while a close prompt is in flight. */
  idlePromptedAt: number | null;
  /** Idle-reclaim (U3): handle of the prompt-deadline timer. */
  idlePromptTimerHandle: unknown | null;
  /** Idle-reclaim (U3): handle of the secondary auto-close timer. */
  idleCloseTimerHandle: unknown | null;
  /**
   * Idle-reclaim dedup (R10): true while an agent-close approval card is in
   * flight, so the idle prompt and the close card never stack. Driven by
   * browser-mcp via setCloseCardPending around its requestApproval round-trip.
   */
  closeCardPending: boolean;
  /**
   * Transient capture session (Kimi usage-login, KTD1): excluded from
   * idle-reclaim so a slow login is never auto-closed mid-capture. Defaults
   * false; chat browser sessions are unaffected.
   */
  transient: boolean;
  /**
   * Last http(s) URL the view navigated to (shell view-navigated events /
   * navigateInSession). The session_lost manual retry rebuilds the view and
   * navigates back here — the partition survives, so login state is kept.
   */
  lastUrl: string | null;
}

export interface BrowserServiceDeps {
  /** App data dir root (reserved for future on-disk state; native sessions keep none). */
  storageDir: string;
  maxSessions: number;
  now: () => number;
  /**
   * Workspace store for the remembered-site read/write paths (U8). Defaults
   * to the process singleton; tests inject an isolated store.
   */
  store?: SqliteStore;
  /**
   * Reads the primary page's current URL (remember-site flow). Default: a
   * short-lived CDP attach + `location.href`. Injectable for tests.
   */
  currentPageUrl?: (baseUrl: string) => Promise<string | null>;
  /**
   * Dumps the browser's session context (remember-site flow): cookies for the
   * open page's URLs (CDP Network.getCookies) plus in-page web storage,
   * covering the currently-open http(s) pages only. Injectable for tests.
   */
  exportContext?: (baseUrl: string) => Promise<unknown>;
  /**
   * Audit sink for site-auth + control-plane (close) events; defaults to the
   * process singleton. Widened for U1's source-tagged close auditing.
   */
  audit?: Pick<BrowserAuditService, 'logSiteAuth' | 'logControl'>;
  /** Injectable timer for idle-reclaim deadlines (U3); defaults to setTimeout. */
  timer?: BrowserServiceTimer;
  /** Server-fixed idle duration before the close prompt (U3). */
  idlePromptMs?: number;
  /** Server-fixed grace after the prompt before auto-close (U3). */
  idleCloseMs?: number;
  /** Per-task opaque credential handles. Injectable for deterministic tests. */
  authBindings?: BrowserAuthBindingVault;
  /**
   * U7 (R8): which CDP target serves browser sessions. Defaults to resolving
   * COMATE_BROWSER_CDP_TARGET + the shell env at spawn time; tests inject a
   * fixed target.
   */
  resolveTarget?: () => BrowserCdpTarget;
  /** U7: control-channel client factory (KTD-11); tests inject a fake. */
  createControlClient?: (endpoint: { controlPort: number; controlToken: string }) => ShellControlClient;
  /** U7: cold-start retry budget for native target discovery; tests shrink it. */
  cdpRetry?: { budgetMs: number; intervalMs: number };
  /**
   * U8 (KTD-11): every session id the sidecar considers live-ish (persisted
   * chat sessions) — the keep list for shell orphan-partition reconciliation.
   * Defaults to the store's full session listing; tests inject a stub.
   */
  listKnownSessionIds?: () => string[];
}

/** Constructor-resolved deps: the U8 + U3 additions have defaults, so internally
 * they are always present (the public interface keeps them optional). */
type ResolvedBrowserServiceDeps = Omit<
  BrowserServiceDeps,
  | 'store'
  | 'currentPageUrl'
  | 'exportContext'
  | 'audit'
  | 'timer'
  | 'idlePromptMs'
  | 'idleCloseMs'
  | 'authBindings'
  | 'resolveTarget'
  | 'createControlClient'
  | 'listKnownSessionIds'
> &
  Required<
    Pick<
      BrowserServiceDeps,
      | 'store'
      | 'currentPageUrl'
      | 'exportContext'
      | 'audit'
      | 'timer'
      | 'idlePromptMs'
      | 'idleCloseMs'
      | 'authBindings'
      | 'resolveTarget'
      | 'createControlClient'
      | 'cdpRetry'
      | 'listKnownSessionIds'
    >
  >;

/** Filesystem/request-id-safe form of a chat sessionId (shared by browser-control). */
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 192 bits of CSPRNG entropy, base64url — unguessable per-session view marker token. */
export function mintViewerToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Default currentPageUrl: a short-lived CDP attach to read the primary
 * page's href (the page the viewer drives). Read-only and invisible to the
 * user — safe during user_in_control.
 */
async function readPrimaryPageUrl(baseUrl: string): Promise<string | null> {
  const page = await connectBrowserPage(baseUrl, { commandTimeoutMs: 5_000 });
  try {
    const href = await page.evaluate<string>('(() => window.location.href)()');
    return typeof href === 'string' && /^https?:\/\//.test(href) ? href : null;
  } finally {
    page.close();
  }
}

/**
 * Default exportContext (U7): cookies via CDP Network.getCookies for the open
 * page's URLs + in-page web-storage dump (KTD-12/AE3 shape).
 */
async function exportBrowserContext(baseUrl: string): Promise<unknown> {
  return exportCdpSessionContext(baseUrl);
}

export class BrowserService {
  private readonly deps: ResolvedBrowserServiceDeps;
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<BrowserEventListener>();
  private readonly releasers = new Set<PendingCardReleaser>();
  /** Kept across browser close so rebound handles can locate remembered state. */
  private readonly authWorkspaceByTask = new Map<string, string>();
  /** Last binding the broker actually used; explicit Remember may persist it. */
  private readonly preferredAuthBindingByTask = new Map<string, string>();
  private initPromise: Promise<void> | null = null;
  private spawnQueue: Promise<void> = Promise.resolve();
  /** U7: last native-path failure, surfaced by /api/health/browser. */
  private lastShellError:
    | { kind: 'control_channel' | 'view_creation' | 'debug_port'; message: string; at: number }
    | undefined;
  private shellEventUnsubscribe: (() => void) | null = null;

  constructor(deps?: Partial<BrowserServiceDeps>) {
    this.deps = {
      storageDir: deps?.storageDir ?? getStorageDir(),
      maxSessions: deps?.maxSessions ?? DEFAULT_MAX_BROWSER_SESSIONS,
      now: deps?.now ?? (() => Date.now()),
      store: deps?.store ?? defaultStore,
      currentPageUrl: deps?.currentPageUrl ?? readPrimaryPageUrl,
      exportContext: deps?.exportContext ?? exportBrowserContext,
      audit: deps?.audit ?? browserAuditService,
      timer: deps?.timer ?? {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
      },
      idlePromptMs: deps?.idlePromptMs ?? DEFAULT_IDLE_PROMPT_MS,
      idleCloseMs: deps?.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS,
      resolveTarget: deps?.resolveTarget ?? (() => resolveBrowserCdpTarget(process.env)),
      createControlClient:
        deps?.createControlClient ??
        ((endpoint) => new ShellControlClient({ port: endpoint.controlPort, token: endpoint.controlToken })),
      cdpRetry: deps?.cdpRetry ?? { budgetMs: 10_000, intervalMs: 300 },
      listKnownSessionIds:
        deps?.listKnownSessionIds ??
        (() => (deps?.store ?? defaultStore).listLocalSessions().map((session) => session.id)),
      authBindings: deps?.authBindings ?? new BrowserAuthBindingVault({
        readRemembered: (taskId, siteKey) => {
          const workspaceId = this.authWorkspaceByTask.get(taskId);
          return workspaceId
            ? (deps?.store ?? defaultStore).getWorkspaceSiteAuthEntry(workspaceId, siteKey)
            : undefined;
        },
      }),
    };
  }

  get maxSessions(): number {
    return this.deps.maxSessions;
  }

  /**
   * One-shot startup reconciliation (KTD-11): the shell deletes orphan
   * persist:comate-browser-* partition dirs whose session is unknown to the
   * sidecar. Idempotent; also chained lazily into the first ensureSession so
   * callers cannot forget it.
   */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.reconcileShellPartitions().catch((err) => {
        diagWarn('[browser] orphan partition reconcile failed:', err);
      });
    }
    return this.initPromise;
  }

  /**
   * U8 (KTD-11): orphan-partition reconciliation — the shell deletes every
   * persist:comate-browser-* partition dir whose session is unknown to the
   * sidecar (persisted session registry + live in-memory entries). Shell
   * target only, best-effort.
   */
  private async reconcileShellPartitions(): Promise<void> {
    const target = this.deps.resolveTarget();
    if (target.kind !== 'shell') return;
    const keep = new Set(this.deps.listKnownSessionIds());
    for (const sessionId of this.registry.keys()) keep.add(sessionId);
    const client = this.deps.createControlClient({
      controlPort: target.controlPort,
      controlToken: target.controlToken,
    });
    try {
      const result = await client.reconcilePartitions([...keep]);
      if ((result.removed?.length ?? 0) > 0 || (result.errors?.length ?? 0) > 0) {
        diagLog(
          `[browser] orphan partition reconcile: removed=${result.removed?.length ?? 0} ` +
            `errors=${result.errors?.length ?? 0}`,
        );
      }
    } catch (err) {
      diagWarn('[browser] orphan partition reconcile failed:', err);
    }
  }

  /** Chainable event subscription (browser_state / browser_closed / browser_unavailable). */
  onEvent(listener: BrowserEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Registry-level pending-card release hook (KTD-5 crash path): when a
   * browser view crashes or detaches, every registered releaser is invoked
   * with the sessionId so hanging browser approval cards can be dismissed.
   * Tolerates the runtime already being gone — releasers must not throw
   * (errors are logged and swallowed). The approval-system wiring lands
   * with U5.
   */
  onPendingCardRelease(releaser: PendingCardReleaser): () => void {
    this.releasers.add(releaser);
    return () => {
      this.releasers.delete(releaser);
    };
  }

  getSession(sessionId: string): BrowserSessionInfo | undefined {
    const entry = this.registry.get(sessionId);
    if (!entry || !entry.handle) return undefined;
    return this.toInfo(entry);
  }

  getControlState(sessionId: string): BrowserControlState | undefined {
    return this.registry.get(sessionId)?.state;
  }

  /**
   * U7 health surface: the last native-path failure with its failure class
   * (control channel / view creation / debug port — the health-browser
   * classification).
   */
  getLastShellError():
    | { kind: 'control_channel' | 'view_creation' | 'debug_port'; message: string; at: number }
    | undefined {
    return this.lastShellError;
  }

  /**
   * The workspace a browser session belongs to, even when the process is
   * starting/lost (audit paths must keep working through crashes — U8).
   */
  getWorkspaceId(sessionId: string): string | undefined {
    return this.registry.get(sessionId)?.workspaceId;
  }

  /**
   * Run CDP `Runtime.evaluate` in a registered session's primary page (KTD4).
   * Used by the Kimi usage-login capture to read the billing JWT in-page after
   * verifying origin. Server-side only; the expression's return value is the
   * only thing handed back to the caller.
   */
  async evaluateInSession(sessionId: string, expression: string): Promise<unknown> {
    const entry = this.registry.get(sessionId);
    if (!entry?.handle) {
      throw new Error(`No live browser session for ${sessionId}`);
    }
    const page = await connectBrowserPage(entry.handle.baseUrl, { commandTimeoutMs: 5_000 });
    return page.evaluate(expression);
  }

  /**
   * Navigate a registered session's page via CDP `Page.navigate` (KTD1/U3) —
   * the capture flow must navigate this way so the tool layer's tracked page
   * and the session's lastUrl stay accurate.
   */
  async navigateInSession(sessionId: string, url: string): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry?.handle) {
      throw new Error(`No live browser session for ${sessionId}`);
    }
    const page = await connectBrowserPage(entry.handle.baseUrl, { commandTimeoutMs: 5_000 });
    await page.navigate(url);
    if (/^https?:\/\//.test(url)) {
      entry.lastUrl = url;
    }
  }

  /**
   * U8 session_lost manual retry (native stack): rebuild the view over the
   * control channel and navigate back to the session's last URL — the
   * partition survives the crash, so the login state is kept. A no-op when
   * the session is unknown, live, or already rebuilding.
   */
  async retrySession(sessionId: string): Promise<{ rebuilding: boolean }> {
    const entry = this.registry.get(sessionId);
    if (!entry || entry.handle || entry.starting) {
      return { rebuilding: false };
    }
    await this.ensureSession({ sessionId, workspaceId: entry.workspaceId });
    const lastUrl = this.registry.get(sessionId)?.lastUrl;
    if (lastUrl) {
      await this.navigateInSession(sessionId, lastUrl).catch((err) => {
        diagWarn(`[browser] retry rebuild of ${sessionId} could not restore ${lastUrl}:`, err);
      });
    }
    return { rebuilding: true };
  }

  listSessions(): BrowserSessionInfo[] {
    const infos: BrowserSessionInfo[] = [];
    for (const entry of this.registry.values()) {
      if (entry.handle) {
        infos.push(this.toInfo(entry));
      }
    }
    return infos;
  }

  /**
   * Drive a control-state transition (U5 handoff flows). No-op when the
   * session is unknown or already in the target state; always re-emits
   * browser_state on a real transition (KTD-9: the state machine is the
   * single source of truth).
   */
  setControlState(sessionId: string, state: BrowserControlState, reason?: string): void {
    const entry = this.registry.get(sessionId);
    if (!entry || entry.state === state) return;
    const previous = entry.state;
    entry.state = state;
    // Idle-reclaim (U3, R5): suppress while a handoff is pending — its timer
    // owns the window. Clearing on entry also covers the race where the idle
    // prompt already fired (close timer armed) and a handoff then starts, so
    // the secondary auto-close can no longer tear down mid-handoff. Resume
    // idle counting when the handoff resolves.
    if (state === 'handoff_pending') {
      this.clearIdleTimers(entry);
      if (entry.idlePromptedAt !== null) {
        entry.idlePromptedAt = null;
        this.emit({ type: 'browser_idle_prompt', sessionId, workspaceId: entry.workspaceId, pending: false });
      }
    } else if (previous === 'handoff_pending' && entry.handle) {
      this.armIdlePrompt(sessionId);
    }
    this.emit({
      type: 'browser_state',
      sessionId,
      workspaceId: entry.workspaceId,
      state,
      port: entry.handle?.port,
      reason,
    });
  }

  /**
   * Spawn (or rebind to) the browser view for a chat session. Rebinding: an
   * entry with a live view is returned as-is regardless of runtime
   * identity (KTD-5). A session_lost entry is respawned — the next tool call
   * after a crash transparently rebuilds the browser (KTD-1).
   */
  async ensureSession(input: {
    sessionId: string;
    workspaceId: string;
    /** Transient capture sessions skip idle-reclaim (KTD1). */
    transient?: boolean;
  }): Promise<BrowserSessionInfo> {
    await this.initialize();
    const { sessionId, workspaceId, transient = false } = input;
    this.authWorkspaceByTask.set(sessionId, workspaceId);

    const existing = this.registry.get(sessionId);
    if (existing) {
      if (existing.starting) {
        return existing.starting;
      }
      if (existing.handle) {
        return this.toInfo(existing);
      }
      // session_lost — fall through to a respawn.
    }

    // Mint (or reuse, on crash rebuild) the per-session view marker token.
    const viewerToken = existing?.viewerToken ?? mintViewerToken();
    const entry: RegistryEntry = existing ?? {
      sessionId,
      workspaceId,
      state: 'agent_in_control',
      handle: null,
      starting: null,
      expectingExit: false,
      startedAt: 0,
      viewerToken,
      siteAuthEligible: false,
      lastActivityAt: 0,
      idlePromptedAt: null,
      idlePromptTimerHandle: null,
      idleCloseTimerHandle: null,
      closeCardPending: false,
      transient,
      lastUrl: null,
    };
    // The spawn captures THIS entry object: its continuation verifies entry
    // identity (not just the sessionId key) so a spawn orphaned by a
    // concurrent teardown + re-ensure is never adopted into the replacement
    // entry.
    const starting = this.spawnForSession(sessionId, workspaceId, viewerToken, entry);
    entry.starting = starting;
    if (!existing) {
      this.registry.set(sessionId, entry);
    }
    try {
      return await starting;
    } catch (err) {
      // Fresh entries leave no phantom behind; a failed rebuild keeps the
      // pre-existing entry in session_lost so the next call can retry.
      if (!existing && this.registry.get(sessionId)?.starting === starting) {
        this.registry.delete(sessionId);
      }
      throw err;
    } finally {
      if (entry.starting === starting) {
        entry.starting = null;
      }
    }
  }

  /** Teardown path 1 (KTD-1): chat session deleted. Idempotent. */
  async teardownSession(
    sessionId: string,
    options?: { preserveRememberedAuthBindings?: boolean },
  ): Promise<void> {
    this.preferredAuthBindingByTask.delete(sessionId);
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    this.registry.delete(sessionId);
    // The canUseTool-layer gate state (submit-semantics refs + navigation
    // ledger) is session-scoped — it must die with the session.
    clearBrowserGateSession(sessionId);
    // Idle-reclaim timers (U3) must not fire after the entry is gone.
    this.clearIdleTimers(entry);
    entry.expectingExit = true;
    await this.stopEntry(entry, { wipeProfile: true });
    if (options?.preserveRememberedAuthBindings) {
      // Browser-only closure destroys raw ephemeral material. Explicitly
      // rebound handles remain valid and are generation-checked on use.
      this.deps.authBindings.browserClosed(sessionId);
    } else {
      // Task/runtime teardown is terminal for every handle.
      this.disposeAuthBindings(sessionId);
    }
    this.emit({
      type: 'browser_closed',
      sessionId,
      workspaceId: entry.workspaceId,
    });
  }

  /** Teardown path 2 (KTD-1): workspace deleted — cascade to all its sessions. */
  async teardownWorkspace(workspaceId: string): Promise<void> {
    const targets = [...this.registry.values()].filter(
      (entry) => entry.workspaceId === workspaceId,
    );
    await Promise.all(targets.map((entry) => this.teardownSession(entry.sessionId)));
  }

  /**
   * Explicit-close sink (U1): the single entry point for the three close
   * paths — agent-confirmed (U2), human button (U4), and idle/timeout (U3).
   * Closing never promotes ephemeral credentials to persisted credentials.
   * Only a prior, explicit Remember action may leave a remembered binding
   * alive; teardown drops all ephemeral bindings. A no-live-session close is
   * an idempotent no-op.
   */
  async closeSession(
    sessionId: string,
    source: BrowserCloseSource,
  ): Promise<CloseSessionResult> {
    const entry = this.registry.get(sessionId);
    if (!entry) {
      return { closed: false };
    }
    const workspaceId = entry.workspaceId;
    await this.teardownSession(sessionId, { preserveRememberedAuthBindings: true });
    this.deps.audit.logControl({
      workspaceId,
      sessionId,
      verb: `browser_closed_${source}`,
      outcome: 'ok',
    });
    return { closed: true };
  }

  // -------------------------------------------------------------------------
  // Idle reclaim (U3): prompt after the idle duration, auto-close after a
  // secondary deadline. Two server-fixed deadlines, an injectable timer, and
  // suppression while a handoff is pending (the handoff timer owns that window).
  // The prompt reaches the client as a browser_idle_prompt event riding the
  // existing browser-state-channel fan-out — it fires with no agent tool call
  // in flight, so it cannot reuse the approval-card round-trip (KTD-3).
  // -------------------------------------------------------------------------

  /**
   * Mark browser activity (agent tool call or human pane ping) and re-arm the
   * idle prompt timer. Any in-flight prompt is dismissed (a banner showing
   * while the session is active again is stale). Public so browser-control
   * (human ping) and browser-mcp (agent tool calls) can both drive it.
   */
  resetIdle(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    this.clearIdleTimers(entry);
    entry.lastActivityAt = this.deps.now();
    if (entry.idlePromptedAt !== null) {
      entry.idlePromptedAt = null;
      this.emit({ type: 'browser_idle_prompt', sessionId, workspaceId: entry.workspaceId, pending: false });
    }
    // Suppress while a handoff is pending — the handoff timer owns that window.
    if (entry.handle && entry.state !== 'handoff_pending') {
      this.armIdlePrompt(sessionId);
    }
  }

  /** Idle-duration elapsed: show the prompt (unless suppressed) and arm the close timer. */
  private onIdlePromptFire(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    entry.idlePromptTimerHandle = null;
    // Session lost (no live process) — nothing to prompt about.
    if (!entry.handle) return;
    // Suppressed during a handoff or while an agent-close card is pending
    // (R10 dedup) — defer by another idle interval.
    if (entry.state === 'handoff_pending' || entry.closeCardPending) {
      this.armIdlePrompt(sessionId);
      return;
    }
    const now = this.deps.now();
    entry.idlePromptedAt = now;
    this.emit({
      type: 'browser_idle_prompt',
      sessionId,
      workspaceId: entry.workspaceId,
      pending: true,
      idleForMs: now - entry.lastActivityAt,
    });
    entry.idleCloseTimerHandle = this.deps.timer.set(
      () => this.onIdleCloseFire(sessionId),
      this.deps.idleCloseMs,
    );
  }

  /** Secondary deadline elapsed with no response: auto-close (the unattended bound). */
  private onIdleCloseFire(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    entry.idleCloseTimerHandle = null;
    // The prompt was dismissed (activity/snooze) — do not close.
    if (entry.idlePromptedAt === null) return;
    // Defensive: a handoff or close card starting after the prompt should have
    // cleared this timer — never auto-close mid-handoff or behind a close card.
    if (entry.state === 'handoff_pending' || entry.closeCardPending) return;
    void this.closeSession(sessionId, 'timeout');
  }

  /** Human clicked "close now" on the idle banner (U4 wires the WS verb). */
  confirmIdleClose(sessionId: string): Promise<CloseSessionResult> {
    return this.closeSession(sessionId, 'idle');
  }

  /** Human clicked "not now" on the idle banner — dismiss and re-arm for a fresh interval. */
  snoozeIdle(sessionId: string): void {
    // resetIdle dismisses any in-flight prompt, bumps activity, and re-arms.
    this.resetIdle(sessionId);
  }

  /**
   * Agent-close approval-card dedup (R10): browser-mcp marks the card in
   * flight around its requestApproval round-trip. While pending, the idle
   * prompt is suppressed (the two "close?" prompts must not stack) and any
   * in-flight idle prompt is dismissed. Resolving the card without teardown
   * (deny/timeout) resumes idle counting.
   */
  setCloseCardPending(sessionId: string, pending: boolean): void {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    if (pending) {
      this.clearIdleTimers(entry);
      if (entry.idlePromptedAt !== null) {
        entry.idlePromptedAt = null;
        this.emit({ type: 'browser_idle_prompt', sessionId, workspaceId: entry.workspaceId, pending: false });
      }
      entry.closeCardPending = true;
    } else {
      entry.closeCardPending = false;
      if (entry.handle) this.resetIdle(sessionId);
    }
  }

  private armIdlePrompt(sessionId: string): void {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    // Transient capture sessions (Kimi usage-login) skip idle-reclaim so a slow
    // login is never auto-closed mid-capture (KTD1). They are torn down
    // explicitly on capture complete/cancel.
    if (entry.transient) return;
    if (entry.idlePromptTimerHandle !== null) {
      this.deps.timer.clear(entry.idlePromptTimerHandle);
    }
    entry.idlePromptTimerHandle = this.deps.timer.set(
      () => this.onIdlePromptFire(sessionId),
      this.deps.idlePromptMs,
    );
  }

  private clearIdleTimers(entry: RegistryEntry): void {
    if (entry.idlePromptTimerHandle !== null) {
      this.deps.timer.clear(entry.idlePromptTimerHandle);
      entry.idlePromptTimerHandle = null;
    }
    if (entry.idleCloseTimerHandle !== null) {
      this.deps.timer.clear(entry.idleCloseTimerHandle);
      entry.idleCloseTimerHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Remembered sites (U8, KTD-8): export on "记住此站点", inject on first open
  // -------------------------------------------------------------------------

  /**
   * "记住此站点" export (checkbox → handback verb, BrowserStateBar). Reads
   * the primary page's URL, derives the PSL site key, dumps the browser
   * context over CDP, filters it to the key's scope (storing an unfiltered
   * dump would replay OTHER sites' cookies on injection), and persists it
   * under the workspace's browserSiteAuth. The value then exists ONLY
   * server-side (GET responses strip it — see workspaces routes).
   *
   * R15 final scope: cookie-primary auth plus web storage for the open page
   * (the export covers currently-open http(s) pages only). Sites whose SSO
   * lives exclusively in IndexedDB or in a closed tab's storage are NOT
   * replayable — documented limitation, not a silent promise.
   */
  async rememberCurrentSite(sessionId: string, bindingId?: string): Promise<RememberSiteResult> {
    const entry = this.registry.get(sessionId);
    if (!entry || !entry.handle) {
      throw new BrowserSiteAuthError(
        'browser_no_session',
        'This chat session has no live browser — nothing to remember.',
      );
    }
    const url = await this.deps.currentPageUrl(entry.handle.baseUrl).catch((err) => {
      throw new BrowserSiteAuthError(
        'export_failed',
        `Could not read the current page: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (!url) {
      throw new BrowserSiteAuthError(
        'browser_no_page',
        'No web page is currently open in the browser — nothing to remember.',
      );
    }
    const keyResult = siteKeyForUrl(url);
    if (!keyResult.ok) {
      throw new BrowserSiteAuthError(
        keyResult.reason === 'ip-literal' ? 'ip_literal' : 'invalid_url',
        keyResult.reason === 'ip-literal'
          ? 'Sites addressed by IP literal cannot be remembered (the same address is a different site on another network).'
          : 'The current page URL cannot be remembered.',
      );
    }
    const raw = await this.deps.exportContext(entry.handle.baseUrl).catch((err) => {
      throw new BrowserSiteAuthError(
        'export_failed',
        `Could not export the browser session: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const scoped = filterContextToScope(
      (raw ?? {}) as { cookies?: unknown; localStorage?: unknown; sessionStorage?: unknown },
      keyResult.key,
    );
    const selectedBindingId = bindingId ?? this.preferredAuthBindingByTask.get(sessionId);
    const bound = selectedBindingId
      ? this.deps.authBindings.materialForRemember(sessionId, selectedBindingId)
      : undefined;
    if (bound && bound.siteKey !== keyResult.key) {
      throw new BrowserSiteAuthError('invalid_url', 'The selected authentication belongs to another site.');
    }
    const storageDomainCount =
      Object.keys(scoped.localStorage ?? {}).length +
      Object.keys(scoped.sessionStorage ?? {}).length;
    if (scoped.cookies.length === 0 && storageDomainCount === 0 && !bound?.bearerToken) {
      throw new BrowserSiteAuthError(
        'empty_context',
        `No login state for ${keyResult.key} was found in the browser — log in first, then remember the site.`,
      );
    }

    const now = new Date().toISOString();
    const workspace = await this.deps.store.get(entry.workspaceId);
    const existing = workspace ? readSiteAuthEntry(workspace.settings ?? {}, keyResult.key) : undefined;
    const existingStored = workspace?.settings.browserSiteAuth?.[keyResult.key];
    const rememberedEntry: BrowserSiteAuthEntry = {
      sessionContext: scoped,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...((bound?.bearerToken ?? existing?.bearerToken)
        ? { bearerToken: bound?.bearerToken ?? existing?.bearerToken }
        : {}),
    };
    // Bookkeeping-only refreshes retain the generation; credential changes
    // rotate it and immediately stale every older rebound handle.
    const unchanged = existing !== undefined && isDeepStrictEqual({
      sessionContext: existing.sessionContext,
      bearerToken: existing.bearerToken,
    }, {
      sessionContext: rememberedEntry.sessionContext,
      bearerToken: rememberedEntry.bearerToken,
    });
    const preservedGeneration = unchanged && existingStored
      ? decodeSiteAuthEntry(existingStored).generation
      : undefined;
    const updated = this.deps.store.setWorkspaceSiteAuthEntry(
      entry.workspaceId,
      keyResult.key,
      rememberedEntry,
      preservedGeneration,
    );
    if (!updated) {
      throw new BrowserSiteAuthError(
        'export_failed',
        'The workspace no longer exists — the site could not be remembered.',
      );
    }
    if (selectedBindingId) {
      const stored = updated.settings.browserSiteAuth?.[keyResult.key];
      if (!stored) throw new BrowserSiteAuthError('export_failed', 'Remembered authentication could not be rebound.');
      this.deps.authBindings.rebindRemembered(sessionId, selectedBindingId, {
        siteKey: keyResult.key,
        generation: decodeSiteAuthEntry(stored).generation,
      });
    }
    this.preferredAuthBindingByTask.delete(sessionId);
    // Audit the FACT of the write with counts only — never the values.
    this.deps.audit.logSiteAuth({
      workspaceId: entry.workspaceId,
      sessionId,
      siteKey: keyResult.key,
      action: 'remember',
      outcome: 'ok',
      detail: `cookies=${scoped.cookies.length} storageDomains=${storageDomainCount}`,
    });
    diagLog(
      `[browser] remembered site ${keyResult.key} for session ${sessionId} ` +
        `(cookies=${scoped.cookies.length} storageDomains=${storageDomainCount})`,
    );
    return { key: keyResult.key, origin: keyResult.origin, cookieCount: scoped.cookies.length, storageDomainCount };
  }

  /** Create an opaque task-owned handle for selected inspection evidence. */
  captureAuthBinding(sessionId: string, material: CapturedAuthMaterial): string {
    if (!this.registry.has(sessionId)) {
      throw new BrowserSiteAuthError('browser_no_session', 'This chat session has no live browser.');
    }
    return this.deps.authBindings.capture(sessionId, material);
  }

  /** Turn one selected sanitized capture candidate into an opaque usable binding. */
  async captureCandidateAuthBinding(
    sessionId: string,
    candidateUrl: string,
    bearerToken?: string,
  ): Promise<string | undefined> {
    return (await this.captureCandidateAuthBindings(
      sessionId,
      [{ url: candidateUrl, ...(bearerToken ? { bearerToken } : {}) }],
    ))[0];
  }

  /** Export browser auth once, then mint candidate-specific opaque handles. */
  async captureCandidateAuthBindings(
    sessionId: string,
    candidates: Array<{ url: string; bearerToken?: string }>,
  ): Promise<Array<string | undefined>> {
    const entry = this.registry.get(sessionId);
    if (!entry?.handle) return candidates.map(() => undefined);
    const raw = await this.deps.exportContext(entry.handle.baseUrl).catch(() => null);
    const contexts = new Map<string, ReturnType<typeof filterContextToScope>>();
    const bindings: Array<string | undefined> = [];
    for (const { url, bearerToken } of candidates) {
      const keyResult = siteKeyForUrl(url);
      if (!keyResult.ok) {
        bindings.push(undefined);
        continue;
      }
      let scoped = contexts.get(keyResult.key);
      if (!scoped) {
        scoped = raw
          ? filterContextToScope(
              raw as { cookies?: unknown; localStorage?: unknown; sessionStorage?: unknown },
              keyResult.key,
            )
          : { cookies: [] };
        contexts.set(keyResult.key, scoped);
      }
      if (scoped.cookies.length === 0 && !bearerToken) {
        bindings.push(undefined);
        continue;
      }
      try {
        const bindingId = this.deps.authBindings.capture(sessionId, {
          siteKey: keyResult.key,
          sourceOrigin: keyResult.origin,
          sessionContext: scoped,
          ...(bearerToken ? { bearerToken } : {}),
        });
        const applicable = this.deps.authBindings.resolve(sessionId, bindingId, url);
        if (applicable.cookies.length === 0 && !applicable.bearerToken) {
          this.deps.authBindings.discard(sessionId, bindingId);
          bindings.push(undefined);
        } else {
          bindings.push(bindingId);
        }
      } catch (error) {
        if (error instanceof BrowserAuthBindingError && error.code === 'auth_binding_limit_reached') {
          bindings.push(...Array.from({ length: candidates.length - bindings.length }, () => undefined));
          break;
        }
        throw error;
      }
    }
    return bindings;
  }

  /** Resolve only native-applicable material; later broker work consumes this. */
  resolveAuthBinding(sessionId: string, bindingId: string, destination: string): ResolvedAuthMaterial {
    const resolved = this.deps.authBindings.resolve(sessionId, bindingId, destination);
    this.preferredAuthBindingByTask.set(sessionId, bindingId);
    return resolved;
  }

  /** Task/runtime terminal hook: unlike browser close, remembered handles die too. */
  disposeAuthBindings(sessionId: string): void {
    this.deps.authBindings.closeTask(sessionId);
    this.authWorkspaceByTask.delete(sessionId);
    this.preferredAuthBindingByTask.delete(sessionId);
  }

  /**
   * Capture the session's context for a site and store it in the GLOBAL
   * site-auth store (cross-workspace), keyed by site. Used so a login captured
   * for one feature (e.g. Kimi usage) is reusable by the chat browser in any
   * workspace. Mirrors rememberCurrentSite but writes the app-level store
   * instead of a workspace's settings. Best-effort: returns silently when the
   * session is gone or there is nothing replayable.
   */
  async rememberGlobalSiteAuth(
    sessionId: string,
    siteKey: string,
    opts?: { bearerToken?: string; bearerCookieName?: string },
  ): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry?.handle) return;
    const raw = await this.deps.exportContext(entry.handle.baseUrl).catch(() => null);
    if (!raw) return;
    const scoped = filterContextToScope(
      raw as { cookies?: unknown; localStorage?: unknown; sessionStorage?: unknown },
      siteKey,
    );
    const storageDomainCount =
      Object.keys(scoped.localStorage ?? {}).length + Object.keys(scoped.sessionStorage ?? {}).length;
    if (scoped.cookies.length === 0 && storageDomainCount === 0) return;

    // Determine the bearer token: explicit (Kimi, from cdp.evaluate) or
    // extracted from the captured cookies by name (BigModel, httpOnly-safe).
    let bearerToken: string | undefined;
    if (opts?.bearerToken) {
      bearerToken = opts.bearerToken;
    } else if (opts?.bearerCookieName) {
      const cookie = scoped.cookies.find(
        (c) => (c as Record<string, unknown>)?.name === opts.bearerCookieName,
      );
      bearerToken = (cookie as Record<string, unknown> | undefined)?.value as string | undefined;
    }

    const now = new Date().toISOString();
    let createdAt = now;
    const existing = readGlobalSiteAuthEntry(this.deps.store, siteKey);
    if (existing) createdAt = existing.entry.createdAt;
    const authEntry: BrowserSiteAuthEntry = {
      sessionContext: scoped,
      createdAt,
      updatedAt: now,
      ...(bearerToken ? { bearerToken } : {}),
    };
    this.deps.store.setGlobalSiteAuth(siteKey, JSON.stringify(authEntry));
    diagLog(
      `[browser] remembered global site ${siteKey} from session ${sessionId} ` +
        `(cookies=${scoped.cookies.length} storageDomains=${storageDomainCount})`,
    );
  }

  /**
   * Injection lookup for the tool layer's open(): consumes the session's
   * one-shot eligibility (first open after every spawn/rebuild) and returns
   * the remembered context when the URL's site key has one. Returns null
   * when ineligible, unmatched, or nothing is stored. Bot sessions never
   * reach this path — the browser MCP server is not registered for them
   * (KTD-4 ③), so bot sessions never inject.
   *
   * Eligibility is consumed synchronously (before any await) so concurrent
   * first-opens cannot double-inject.
   */
  async prepareSiteAuthInjection(sessionId: string, url: string): Promise<SiteAuthInjection | null> {
    const entry = this.registry.get(sessionId);
    if (!entry || !entry.siteAuthEligible) return null;
    entry.siteAuthEligible = false;
    if (!entry.handle) return null;
    const keyResult = siteKeyForUrl(url);
    if (!keyResult.ok) return null;
    const workspace = await this.deps.store.get(entry.workspaceId);
    let siteAuthEntry = workspace
      ? readSiteAuthEntry(workspace.settings ?? {}, keyResult.key)
      : undefined;
    let generation = workspace?.settings.browserSiteAuth?.[keyResult.key]
      ? decodeSiteAuthEntry(workspace.settings.browserSiteAuth[keyResult.key]).generation
      : undefined;
    let fromGlobal = false;
    if (!siteAuthEntry) {
      // Global fallback: a login captured for another feature (e.g. Kimi usage)
      // is reusable by the chat browser in any workspace.
      const global = readGlobalSiteAuthEntry(this.deps.store, keyResult.key);
      if (global) {
        siteAuthEntry = global.entry;
        generation = global.generation;
        fromGlobal = true;
      }
    }
    if (!siteAuthEntry) return null;
    const now = new Date().toISOString();
    if (fromGlobal) {
      this.deps.store.setGlobalSiteAuth(
        keyResult.key,
        JSON.stringify({ ...siteAuthEntry, lastUsedAt: now }),
        generation,
      );
    } else {
      this.deps.store.setWorkspaceSiteAuthEntry(entry.workspaceId, keyResult.key, {
        ...siteAuthEntry,
        lastUsedAt: now,
      }, generation);
    }
    this.deps.audit.logSiteAuth({
      workspaceId: entry.workspaceId,
      sessionId,
      siteKey: keyResult.key,
      action: 'inject',
      outcome: 'ok',
      detail: `cookies=${siteAuthEntry.sessionContext.cookies.length}`,
    });
    diagLog(`[browser] injecting remembered site ${keyResult.key} for session ${sessionId}`);
    return { key: keyResult.key, context: siteAuthEntry.sessionContext };
  }

  /** Sidecar shutdown: destroy every live view within the 2s budget (KTD-1). */
  async shutdown(): Promise<void> {
    this.shellEventUnsubscribe?.();
    this.shellEventUnsubscribe = null;
    const entries = [...this.registry.values()];
    this.registry.clear();
    for (const entry of entries) {
      entry.expectingExit = true;
      this.clearIdleTimers(entry);
      entry.closeWatcher?.();
      entry.closeWatcher = undefined;
    }
    await Promise.all(
      entries.map((entry) =>
        // Partitions survive app restarts — only session/workspace deletion
        // wipes on-disk login state.
        this.stopEntry(entry, { wipeProfile: false }).catch((err) => {
          diagWarn(`[browser] failed to stop session ${entry.sessionId} during shutdown:`, err);
        }),
      ),
    );
  }

  private async spawnForSession(
    sessionId: string,
    workspaceId: string,
    viewerToken: string,
    entry: RegistryEntry,
  ): Promise<BrowserSessionInfo> {
    const target = this.deps.resolveTarget();
    if (target.kind === 'misconfigured') {
      throw this.unavailable(sessionId, workspaceId, 'browser_start_failed', target.reason);
    }
    return this.spawnNativeForSession(sessionId, workspaceId, viewerToken, target, entry);
  }

  /**
   * Registration tail: adopt the live handle into the registry entry, arm
   * idle-reclaim, wire the exit listener (view-crashed / view-destroyed /
   * targetDestroyed all land in handleProcessExit).
   */
  private adoptHandle(
    entry: RegistryEntry,
    sessionId: string,
    workspaceId: string,
    handle: ShellViewHandle,
  ): BrowserSessionInfo {
    // Identity check, not a key lookup: a replacement entry minted by a
    // concurrent ensureSession under the same sessionId must not absorb
    // this handle.
    const current = this.registry.get(sessionId);
    if (current !== entry || entry.expectingExit) {
      throw new BrowserUnavailableError(
        'browser_start_failed',
        `Browser session ${sessionId} was torn down while starting.`,
      );
    }
    current.handle = handle;
    current.state = 'agent_in_control';
    current.startedAt = this.deps.now();
    // Fresh view — the first open() may inject a remembered site (U8).
    current.siteAuthEligible = true;
    // Arm the idle-reclaim prompt timer (U3): the clock starts now.
    current.lastActivityAt = this.deps.now();
    this.armIdlePrompt(sessionId);
    handle.onExit(() => this.handleProcessExit(sessionId, handle));
    // A view that died between creation and here has already transitioned
    // the entry to session_lost via handleProcessExit — skip the ready event.
    if (current.handle === handle && current.state === 'agent_in_control') {
      this.emit({
        type: 'browser_state',
        sessionId,
        workspaceId,
        state: 'agent_in_control',
        port: handle.port,
      });
    }
    return this.toInfo(current);
  }

  // -------------------------------------------------------------------------
  // Spawn path (U7, KTD-6/KTD-10/KTD-11): the browser lives in the shell
  // (per-session partition view created over the control channel) or in an
  // operator-supplied external Chromium (COMATE_BROWSER_CDP_TARGET — the
  // R8/AE2 fallback, per-session throwaway browser context). No Chromium
  // resolution, no profile dirs, no pidfiles.
  // -------------------------------------------------------------------------

  private spawnNativeForSession(
    sessionId: string,
    workspaceId: string,
    viewerToken: string,
    target: BrowserCdpTarget & { kind: 'shell' | 'external' },
    entry: RegistryEntry,
  ): Promise<BrowserSessionInfo> {
    const task = this.spawnQueue.then(async (): Promise<ShellViewHandle> => {
      // Cap rule: count OTHER live/starting sessions inside the spawn mutex.
      const othersActive = [...this.registry.values()].filter(
        (e) => e.sessionId !== sessionId && (e.handle || e.starting),
      ).length;
      if (othersActive >= this.deps.maxSessions) {
        throw this.unavailable(
          sessionId,
          workspaceId,
          'browser_limit_reached',
          `Embedded browser limit reached (${this.deps.maxSessions} concurrent sessions). ` +
            'Close a browser session and try again.',
        );
      }
      const marker = `comate-view-${viewerToken}`;
      if (target.kind === 'shell') {
        return this.spawnShellView(sessionId, workspaceId, marker, target);
      }
      return this.spawnExternalTarget(sessionId, workspaceId, marker, target, entry);
    });
    const handleTask = task.then(async (handle) => {
      // Teardown raced the spawn — and a concurrent ensureSession may already
      // have minted a replacement entry under the same sessionId key. Verify
      // the captured entry's identity (not just the key): an orphaned spawn
      // stops its fresh view/target instead of being adopted into the
      // replacement entry (adoption would orphan the view when the new
      // entry's own spawn then fails on the shell's 409 view_exists).
      if (this.registry.get(sessionId) !== entry || entry.expectingExit) {
        await handle.stop();
        throw new BrowserUnavailableError(
          'browser_start_failed',
          `Browser session ${sessionId} was torn down while starting.`,
        );
      }
      return this.adoptHandle(entry, sessionId, workspaceId, handle);
    });
    this.spawnQueue = handleTask.then(
      () => undefined,
      () => undefined,
    );
    return handleTask;
  }

  private async spawnShellView(
    sessionId: string,
    workspaceId: string,
    marker: string,
    target: BrowserCdpTarget & { kind: 'shell' },
  ): Promise<ShellViewHandle> {
    const client = this.deps.createControlClient({
      controlPort: target.controlPort,
      controlToken: target.controlToken,
    });
    this.ensureShellEventStream(client);
    try {
      await client.createView({ sessionId, marker });
      this.lastShellError = undefined;
    } catch (err) {
      const kind = err instanceof ControlChannelError && err.kind === 'unreachable'
        ? 'control_channel'
        : 'view_creation';
      const message = err instanceof Error ? err.message : String(err);
      this.lastShellError = { kind, message, at: this.deps.now() };
      throw this.unavailable(
        sessionId,
        workspaceId,
        'browser_start_failed',
        kind === 'control_channel'
          ? `The desktop shell's browser control channel is unreachable: ${message}`
          : `The desktop shell could not create the browser view: ${message}`,
      );
    }
    let targetId: string;
    try {
      targetId = await retryDuringColdStart(
        async () => {
          const found = await findCdpTargetIdByMarker({ port: target.debugPort }, marker);
          if (!found) throw new Error('view target not yet visible on the debug port');
          return found;
        },
        { budgetMs: this.deps.cdpRetry.budgetMs, intervalMs: this.deps.cdpRetry.intervalMs },
      );
      this.lastShellError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastShellError = { kind: 'debug_port', message, at: this.deps.now() };
      await client.destroyView(sessionId).catch(() => undefined);
      throw this.unavailable(
        sessionId,
        workspaceId,
        'browser_start_failed',
        `The shell's Chromium debug port did not expose the new view: ${message}`,
      );
    }
    return new ShellViewHandle({
      sessionId,
      debugPort: target.debugPort,
      targetId,
      partition: `persist:comate-browser-${sanitizeSessionId(sessionId)}`,
      client,
    });
  }

  private async spawnExternalTarget(
    sessionId: string,
    workspaceId: string,
    marker: string,
    target: BrowserCdpTarget & { kind: 'external' },
    entry: RegistryEntry,
  ): Promise<ShellViewHandle> {
    let created: { targetId: string; browserContextId?: string };
    try {
      created = await createShellTarget({
        host: target.host,
        port: target.port,
        url: `about:blank#${marker}`,
        isolate: true,
      });
    } catch (err) {
      throw this.unavailable(
        sessionId,
        workspaceId,
        'browser_start_failed',
        `The external CDP endpoint at ${target.host}:${target.port} could not create a target: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const handle = new ShellViewHandle({
      sessionId,
      host: target.host,
      debugPort: target.port,
      targetId: created.targetId,
      ...(created.browserContextId ? { browserContextId: created.browserContextId } : {}),
    });
    // Crash/lost signal for the external path: a persistent browser-level
    // connection watches for our target's destruction; the socket dying means
    // the whole endpoint went away. Both land in handleProcessExit via
    // notifyExit (KTD-14 session_lost semantics).
    void (async () => {
      let intentionalClose = false;
      try {
        const info = await fetchCdpBrowserInfo({ host: target.host, port: target.port });
        const watcher = await CdpConnection.connect(info.browserWsUrl, {});
        await watcher.send('Target.setDiscoverTargets', { discover: true });
        const off = watcher.onEvent((event) => {
          if (event.method !== 'Target.targetDestroyed') return;
          if ((event.params as { targetId?: string }).targetId === created.targetId) {
            handle.notifyExit({ code: null, signal: null });
          }
        });
        watcher.onClose(() => {
          if (!intentionalClose) handle.notifyExit({ code: null, signal: null });
        });
        // Attach the watcher teardown only when the entry that queued this
        // spawn is still the registered one — an orphaned spawn's watcher
        // must not piggyback on a replacement entry.
        if (this.registry.get(sessionId) === entry) {
          entry.closeWatcher = () => {
            intentionalClose = true;
            off();
            watcher.close();
          };
        } else {
          intentionalClose = true;
          watcher.close();
        }
      } catch (err) {
        diagWarn(`[browser] external target watcher failed for ${sessionId}:`, err);
      }
    })();
    return handle;
  }

  /** One SSE subscription per service instance, lazily opened on first shell spawn. */
  private ensureShellEventStream(client: ShellControlClient): void {
    if (this.shellEventUnsubscribe) return;
    this.shellEventUnsubscribe = client.subscribeEvents(
      (event: ShellViewEvent) => {
        if (event.type === 'view-activity') {
          this.resetIdle(event.sessionId);
          return;
        }
        if (event.type === 'view-navigated') {
          // U8: track the view's last page so a session_lost manual retry can
          // rebuild the view onto it (the partition keeps the login state).
          const entry = this.registry.get(event.sessionId);
          if (entry && typeof event.url === 'string' && /^https?:\/\//.test(event.url)) {
            entry.lastUrl = event.url;
          }
          return;
        }
        const entry = this.registry.get(event.sessionId);
        if (!entry || entry.expectingExit) return;
        if (entry.handle instanceof ShellViewHandle) {
          diagWarn(
            `[browser] shell reported ${event.type} for session ${event.sessionId}` +
              (event.type === 'view-crashed' ? ` (reason=${event.reason ?? 'unknown'})` : ''),
          );
          entry.handle.notifyExit({ code: null, signal: null });
        }
      },
      () => {
        void this.reconcileLiveShellViews(client).catch((err) => {
          diagWarn('[browser] post-reconnect view reconcile failed:', err);
        });
      },
    );
  }

  /**
   * The SSE stream is the only liveness signal for shell views and it is
   * lossy: the shell emits only to currently connected clients (no replay),
   * so a crash inside the reconnect gap (or before handle adoption) is
   * dropped and the dead view would stay 'live' forever. After every
   * successful /events (re)subscription, probe each live shell view once
   * and drive the normal session_lost path for the ones that vanished.
   * Cheap (one probe per live shell entry per reconnect) and best-effort
   * (probe failures are logged and skipped — never read as a lost view).
   */
  private async reconcileLiveShellViews(client: ShellControlClient): Promise<void> {
    for (const entry of [...this.registry.values()]) {
      const handle = entry.handle;
      // Shell views only — external targets are not hosted by the shell and
      // have their own targetDestroyed watcher.
      if (!(handle instanceof ShellViewHandle) || handle.partition === undefined) continue;
      let exists: boolean;
      try {
        exists = await client.viewExists(entry.sessionId);
      } catch (err) {
        diagWarn(`[browser] post-reconnect view probe failed for ${entry.sessionId}:`, err);
        continue;
      }
      if (exists) continue;
      diagWarn(
        `[browser] shell view for session ${entry.sessionId} vanished while the event stream was down`,
      );
      handle.notifyExit({ code: null, signal: null });
    }
  }

  private handleProcessExit(
    sessionId: string,
    handle: ShellViewHandle,
  ): void {
    const entry = this.registry.get(sessionId);
    if (!entry || entry.handle !== handle || entry.expectingExit) {
      return;
    }
    entry.handle = null;
    entry.state = 'session_lost';
    entry.closeWatcher?.();
    entry.closeWatcher = undefined;
    this.deps.authBindings.browserClosed(sessionId);
    this.clearIdleTimers(entry);
    const reason = 'Browser view crashed or was destroyed (render-process-gone / detach)';
    diagWarn(`[browser] session ${sessionId} lost: ${reason}`);

    // Registry-level pending-card release (U5 wires the approval system in).
    for (const releaser of this.releasers) {
      try {
        releaser(sessionId);
      } catch (err) {
        diagWarn('[browser] pending-card releaser threw:', err);
      }
    }

    this.emit({
      type: 'browser_state',
      sessionId,
      workspaceId: entry.workspaceId,
      state: 'session_lost',
      reason,
    });
  }

  private async stopEntry(
    entry: RegistryEntry,
    options: { wipeProfile: boolean },
  ): Promise<void> {
    if (entry.starting) {
      // Let the in-flight spawn settle; its continuation stops the handle
      // itself when it sees expectingExit.
      await entry.starting.catch(() => undefined);
    }
    entry.closeWatcher?.();
    entry.closeWatcher = undefined;
    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      await handle.stop();
    }
    if (options.wipeProfile) {
      // The wipeProfile semantic is the partition wipe over the control
      // channel (KTD-11): session/workspace deletion must not leave on-disk
      // login state behind. External targets persist nothing (the throwaway
      // browser context is disposed on stop).
      if (handle) {
        await handle.wipe();
      } else if (entry.state === 'session_lost') {
        // session_lost entry — the crash path already dropped the handle,
        // but the on-disk partition (login state) must still be wiped. (A
        // handle nulled any other way — e.g. a spawn torn down in flight —
        // never exposed login state, so nothing extra is wiped.)
        await this.wipeShellViewWithoutHandle(entry.sessionId);
      }
    }
  }

  /**
   * wipeProfile for an entry whose handle is already gone (session_lost):
   * the on-disk persist:comate-browser-<id> partition (login cookies) must
   * not survive session/workspace deletion just because there is no live
   * view. Shell target only; fully best-effort — teardown must never fail
   * or block on the control channel here.
   */
  private async wipeShellViewWithoutHandle(sessionId: string): Promise<void> {
    let target: BrowserCdpTarget;
    try {
      target = this.deps.resolveTarget();
    } catch (err) {
      diagWarn(`[browser] could not resolve the CDP target to wipe ${sessionId}:`, err);
      return;
    }
    if (target.kind !== 'shell') return;
    const client = this.deps.createControlClient({
      controlPort: target.controlPort,
      controlToken: target.controlToken,
    });
    await client.destroyView(sessionId).catch((err) => {
      diagWarn(`[browser] control-channel view destroy failed for ${sessionId}:`, err);
    });
    await client.wipePartition(sessionId).catch((err) => {
      diagWarn(`[browser] control-channel partition wipe failed for ${sessionId}:`, err);
    });
  }

  private unavailable(
    sessionId: string,
    workspaceId: string,
    code: BrowserUnavailableCode,
    reason: string,
  ): BrowserUnavailableError {
    // Dual presentation (KTD-1): a typed, machine-readable error for the tool
    // layer plus a browser_unavailable event for the panel (diagLog is the U1
    // placeholder channel; the WS channel lands with U5).
    diagWarn(`[browser] unavailable for session ${sessionId} (${code}): ${reason}`);
    this.emit({ type: 'browser_unavailable', sessionId, workspaceId, code, reason });
    return new BrowserUnavailableError(code, reason);
  }

  private emit(event: BrowserServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        diagWarn('[browser] event listener threw:', err);
      }
    }
  }

  private toInfo(entry: RegistryEntry): BrowserSessionInfo {
    const handle = entry.handle;
    return {
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      state: entry.state,
      port: handle?.port ?? 0,
      pid: handle?.pid,
      baseUrl: handle?.baseUrl ?? '',
      userDataDir: handle?.userDataDir ?? '',
      startedAt: entry.startedAt,
    };
  }
}

export const browserService = new BrowserService();
