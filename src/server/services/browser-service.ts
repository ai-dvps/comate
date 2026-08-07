import path from 'path';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { getStorageDir } from '../storage/data-dir.js';
import { resolveChromium } from '../utils/resolve-chromium.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import type { BrowserSessionContext, BrowserSiteAuthEntry } from '../models/workspace.js';
import {
  CdpConnection,
  connectBrowserPage,
  createShellTarget,
  exportCdpSessionContext,
  fetchCdpBrowserInfo,
  findCdpTargetIdByMarker,
  parseCdpPageBaseUrl,
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
  allocateLoopbackPort,
  cleanupStaleSteelProcesses,
  reapStaleProfileLock,
  SteelProcess,
  type SteelExitInfo,
  type SteelProcessHandle,
  type SteelProcessOptions,
  type StaleCleanupReport,
} from './browser-steel-process.js';
import { getBrowserAllowInsecureCerts } from './browser-app-settings.js';
import {
  BrowserAuthBindingError,
  BrowserAuthBindingVault,
  type CapturedAuthMaterial,
  type ResolvedAuthMaterial,
} from './browser-auth-binding.js';

/**
 * browser-service — Steel process orchestration and session lifecycle (KTD-1,
 * KTD-5). One vendored-Steel child process per active chat session, keyed by
 * chat sessionId — deliberately NOT attached to a runtime or SDK MCP server
 * instance: runtime rebuilds (provider switch, bot policy change, idle close)
 * rebind to the existing browser by sessionId (KTD-5). `forkSession` mints a
 * new sessionId, so a forked chat cold-starts its own browser (KTD-1).
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
 * A sidecar force-kill is covered by pidfiles: the next boot's
 * cleanupStaleSteelProcesses reaps orphans (initialize(), lazy on first use).
 */

export type BrowserControlState =
  | 'agent_in_control'
  | 'user_in_control'
  | 'handoff_pending'
  | 'session_lost';

export type BrowserUnavailableCode =
  | 'browser_limit_reached'
  | 'browser_chromium_missing'
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
  handle: SteelProcessHandle | ShellViewHandle | null;
  starting: Promise<BrowserSessionInfo> | null;
  /** External-CDP targetDestroyed watcher teardown (native fallback path). */
  closeWatcher?: (() => void) | undefined;
  /** Set when teardown is in flight so an exit is not treated as a crash. */
  expectingExit: boolean;
  startedAt: number;
  /**
   * Per-session viewer credential (KTD-7), minted once per registry entry and
   * handed to Steel as a DOMAIN path prefix at spawn — the pinned viewer HTML
   * then bakes its cast WebSocket URL under `…/s/<token>/`, so the viewer
   * proxy (U7) can authenticate HTTP and WS with the same path-carried token.
   * Survives crash rebuilds (the entry persists across session_lost); dies
   * with the entry on teardown.
   */
  viewerToken: string;
  /**
   * One-shot remembered-site injection eligibility (U8): set on every
   * successful (re)spawn, consumed by the first open() — injection happens
   * exactly once per Steel process, before the first navigation.
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
  /** App data dir root; profiles and pidfiles live under `<dir>/browser`. */
  storageDir: string;
  maxSessions: number;
  allocatePort: () => Promise<number>;
  /** Lazy Chromium resolution (allowDownload: true — first use may download). */
  resolveChromiumPath: () => Promise<string | undefined>;
  createProcess: (options: SteelProcessOptions) => SteelProcessHandle;
  cleanupStale: (runDir: string) => Promise<StaleCleanupReport>;
  now: () => number;
  /**
   * U7 viewer proxy wiring: maps a session's viewer token to the DOMAIN value
   * baked into its Steel child env (`127.0.0.1:<proxyPort>/s/<token>`). Steel
   * builds the viewer's absolute cast wsUrl from DOMAIN, so the viewer only
   * ever talks to the proxy, with the token carried in the path. Unset in
   * tests without a proxy — Steel then points the viewer at its own port.
   */
  viewerDomain?: (token: string) => string | undefined;
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
   * Dumps the browser's session context (remember-site flow) — the vendored
   * Steel `GET /v1/sessions/:id/context` contract: cookies are browser-wide,
   * storage covers the currently-open http(s) pages only (U8 entry
   * criterion: LevelDB disk extraction is stubbed in the vendored build).
   * Injectable for tests.
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
  /**
   * Resolves the app-global "allow insecure certificates" value applied to
   * every spawned Chrome (passed as --ignore-certificate-errors). Defaults to
   * reading browser-app-settings (default ON); tests inject a stub.
   */
  resolveIgnoreCertErrors?: () => Promise<boolean>;
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
  | 'resolveIgnoreCertErrors'
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
      | 'resolveIgnoreCertErrors'
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

/** 192 bits of CSPRNG entropy, base64url — unguessable per-session viewer credential. */
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
 * Default exportContext: the vendored Steel `GET /v1/sessions/:id/context`
 * (pinned SHA d6b15d5). U8 entry criterion, verified against the vendored
 * build: cookies are complete (CDP Network.getAllCookies); localStorage /
 * sessionStorage / IndexedDB cover only the currently-open http(s) pages —
 * the LevelDB disk extraction silently degrades to empty because U2 stubs
 * classic-level (the reader throws on construction and the failure is
 * swallowed to `{}`). The sessionId path segment is ignored by the vendored
 * handler; "current" is a documentation placeholder.
 */
async function exportSteelContext(baseUrl: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/v1/sessions/current/context`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Steel context export failed with status ${res.status}`);
  }
  return res.json();
}

/**
 * Default exportContext dispatcher (U7): the __comate-cdp__ baseUrl convention
 * exports via CDP (Network.getCookies + in-page storage dump, same shape);
 * anything else keeps the vendored Steel HTTP export.
 */
async function exportBrowserContext(baseUrl: string): Promise<unknown> {
  if (parseCdpPageBaseUrl(baseUrl)) {
    return exportCdpSessionContext(baseUrl);
  }
  return exportSteelContext(baseUrl);
}

export class BrowserService {
  private readonly deps: ResolvedBrowserServiceDeps;
  private readonly registry = new Map<string, RegistryEntry>();
  /** token → sessionId for O(1) proxy lookups (kept in step with registry). */
  private readonly tokenIndex = new Map<string, string>();
  private readonly listeners = new Set<BrowserEventListener>();
  private readonly releasers = new Set<PendingCardReleaser>();
  /** Ports reserved by live, starting, or not-yet-reaped processes. */
  private readonly portsInUse = new Set<number>();
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
      allocatePort: deps?.allocatePort ?? allocateLoopbackPort,
      resolveChromiumPath:
        deps?.resolveChromiumPath ??
        (async () => (await resolveChromium({ allowDownload: true }))?.executablePath),
      createProcess: deps?.createProcess ?? ((options) => new SteelProcess(options)),
      cleanupStale: deps?.cleanupStale ?? cleanupStaleSteelProcesses,
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
      resolveIgnoreCertErrors: deps?.resolveIgnoreCertErrors ?? (() => getBrowserAllowInsecureCerts()),
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
   * One-shot startup cleanup of orphaned Steel processes from a previous
   * sidecar run (pidfile/port probe, KTD-1). Idempotent; also chained lazily
   * into the first ensureSession so callers cannot forget it.
   */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.deps
        .cleanupStale(this.runDir())
        .then((report) => {
          if (report.scanned > 0) {
            diagLog(
              `[browser] startup residue cleanup: scanned=${report.scanned} ` +
                `killed=${report.killed} removed=${report.removed} skipped=${report.skipped}`,
            );
          }
        })
        .then(() => this.reconcileShellPartitions())
        .catch((err) => {
          diagWarn('[browser] startup residue cleanup failed:', err);
        });
    }
    return this.initPromise;
  }

  /**
   * U8 (KTD-11): orphan-partition reconciliation — the shell deletes every
   * persist:comate-browser-* partition dir whose session is unknown to the
   * sidecar (persisted session registry + live in-memory entries). Mirrors
   * the pidfile/SingletonLock cleanup above; shell target only, best-effort.
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
   * Registry-level pending-card release hook (KTD-5 crash path): when a Steel
   * process dies, every registered releaser is invoked with the sessionId so
   * hanging browser approval cards can be dismissed. Tolerates the runtime
   * already being gone — releasers must not throw (errors are logged and
   * swallowed). The approval-system wiring lands with U5.
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

  /** The session's viewer credential (KTD-7); undefined when the session is unknown. */
  getViewerToken(sessionId: string): string | undefined {
    return this.registry.get(sessionId)?.viewerToken;
  }

  /**
   * Reverse lookup for the viewer proxy: resolves a token to its session.
   * `info` is undefined when the token is valid but the Steel process is not
   * live (starting, session_lost) — the proxy answers an explicit 503 there,
   * vs a generic 403 for unknown tokens.
   */
  findSessionByViewerToken(
    token: string,
  ): { sessionId: string; info: BrowserSessionInfo | undefined } | undefined {
    const sessionId = this.tokenIndex.get(token);
    if (!sessionId) return undefined;
    const entry = this.registry.get(sessionId);
    if (!entry || entry.viewerToken !== token) return undefined;
    return { sessionId, info: entry.handle ? this.toInfo(entry) : undefined };
  }

  /**
   * Post-construction wiring for the U7 viewer proxy (the proxy's port only
   * exists once it starts, which happens after this service is constructed).
   */
  setViewerDomainProvider(provider: ((token: string) => string | undefined) | undefined): void {
    this.deps.viewerDomain = provider;
  }

  getControlState(sessionId: string): BrowserControlState | undefined {
    return this.registry.get(sessionId)?.state;
  }

  /**
   * U7 health surface: the last native-path failure with its failure class
   * (control channel / view creation / debug port — the health-browser
   * classification, replacing Steel-centric messaging for shell sessions).
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
   * Navigate a registered session's page via CDP `Page.navigate` (KTD1/U3).
   * Steel only registers/tracks pages reached through Page.navigate (a JS
   * `location.href` assignment is NOT tracked), and the viewer-proxy warm-up
   * requires a tracked page — so the capture flow must navigate this way.
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
   * Spawn (or rebind to) the Steel child for a chat session. Rebinding: an
   * entry with a live process is returned as-is regardless of runtime
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

    // Mint (or reuse, on crash rebuild) the per-session viewer token (KTD-7).
    const viewerToken = existing?.viewerToken ?? mintViewerToken();
    const starting = this.spawnForSession(sessionId, workspaceId, existing, viewerToken);
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
    entry.starting = starting;
    if (!existing) {
      this.registry.set(sessionId, entry);
      this.tokenIndex.set(viewerToken, sessionId);
    }
    try {
      return await starting;
    } catch (err) {
      // Fresh entries leave no phantom behind; a failed rebuild keeps the
      // pre-existing entry in session_lost so the next call can retry.
      if (!existing && this.registry.get(sessionId)?.starting === starting) {
        this.registry.delete(sessionId);
        this.tokenIndex.delete(viewerToken);
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
    this.tokenIndex.delete(entry.viewerToken);
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
   * context from Steel, filters it to the key's scope (the vendored export
   * returns cookies browser-wide — storing it unfiltered would replay OTHER
   * sites' cookies on injection), and persists it under the workspace's
   * browserSiteAuth. The value then exists ONLY server-side (GET responses
   * strip it — see workspaces routes).
   *
   * R15 final scope: cookie-primary auth plus web storage for the open page
   * (see exportSteelContext's entry-criterion note). Sites whose SSO lives
   * exclusively in IndexedDB or in a closed tab's storage are NOT replayable
   * — documented limitation, not a silent promise.
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

  /** Sidecar shutdown: SIGKILL every Steel tree within the 2s budget (KTD-1). */
  async shutdown(): Promise<void> {
    this.shellEventUnsubscribe?.();
    this.shellEventUnsubscribe = null;
    const entries = [...this.registry.values()];
    this.registry.clear();
    this.tokenIndex.clear();
    for (const entry of entries) {
      entry.expectingExit = true;
      this.clearIdleTimers(entry);
      entry.closeWatcher?.();
      entry.closeWatcher = undefined;
    }
    await Promise.all(
      entries.map((entry) =>
        // Profiles survive app restarts — only session/workspace deletion wipes
        // on-disk login state.
        this.stopEntry(entry, { wipeProfile: false }).catch((err) => {
          diagWarn(`[browser] failed to stop session ${entry.sessionId} during shutdown:`, err);
        }),
      ),
    );
  }

  private async spawnForSession(
    sessionId: string,
    workspaceId: string,
    entry: RegistryEntry | undefined,
    viewerToken: string,
  ): Promise<BrowserSessionInfo> {
    const target = this.deps.resolveTarget();
    if (target.kind === 'misconfigured') {
      throw this.unavailable(sessionId, workspaceId, 'browser_start_failed', target.reason);
    }
    if (target.kind === 'steel') {
      return this.spawnSteelForSession(sessionId, workspaceId, entry, viewerToken);
    }
    return this.spawnNativeForSession(sessionId, workspaceId, viewerToken, target);
  }

  private async spawnSteelForSession(
    sessionId: string,
    workspaceId: string,
    entry: RegistryEntry | undefined,
    viewerToken: string,
  ): Promise<BrowserSessionInfo> {
    // Chromium resolution may download (~100MB) and must not serialize other
    // spawns; the port allocation + spawn critical section below is the only
    // part that needs the mutex.
    let chromiumPath: string | undefined;
    try {
      chromiumPath = await this.deps.resolveChromiumPath();
    } catch (err) {
      throw this.unavailable(
        sessionId,
        workspaceId,
        'browser_chromium_missing',
        `Chromium resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!chromiumPath) {
      throw this.unavailable(
        sessionId,
        workspaceId,
        'browser_chromium_missing',
        'No Chromium executable available. The embedded browser uses a bundled, ' +
          'isolated Chrome for Testing by default; if it is missing, reinstall ' +
          'the app, set COMATE_CHROMIUM_PATH, or set COMATE_USE_SYSTEM_CHROME=1 ' +
          'to drive your installed Chrome.',
      );
    }

    // Critical section: cap re-check + port reservation + child creation. The
    // reserved port stays in portsInUse until the process stops, so concurrent
    // spawns can never double-allocate (KTD-1 dynamic ports).
    const handle = await this.enqueueSpawn(sessionId, workspaceId, chromiumPath, viewerToken);

    // A previous Steel process for this session may have been torn down
    // without reaping its Chrome child, leaving an orphan Chrome holding the
    // deterministic profile dir's SingletonLock. Chrome then refuses to relaunch
    // into the same dir ("Failed to create SingletonLock: File exists"),
    // live-details returns 500, and the viewer pane stays black. Clear the lock
    // (and any verified orphan) before the new Steel launches Chrome into it.
    try {
      const reaped = await reapStaleProfileLock(handle.userDataDir);
      if (reaped.cleared) {
        diagLog(
          `[browser] cleared stale profile lock for session ${sessionId} ` +
            `(${reaped.reason}, holderPid=${reaped.holderPid ?? 'n/a'})`,
        );
      }
    } catch (err) {
      diagWarn(
        `[browser] stale profile lock reap failed for session ${sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await handle.start();
      diagLog(
        `[browser] steel started for session ${sessionId} on port ${handle.port} ` +
          `(pid=${handle.pid ?? 'unknown'})`,
      );
    } catch (err) {
      this.portsInUse.delete(handle.port);
      if (!entry) {
        // Fresh session that never came up: drop the half-created profile so
        // failed first spawns leave no disk residue. Rebuilds keep the
        // profile (login state survives a crash).
        await rm(this.profileDirFor(sessionId), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      diagWarn(`[browser] steel start failed for session ${sessionId}:`, reason);
      throw this.unavailable(sessionId, workspaceId, 'browser_start_failed', reason);
    }

    const current = this.registry.get(sessionId);
    if (!current || current.expectingExit) {
      // Teardown raced the spawn — kill the fresh child instead of registering.
      await handle.stop();
      this.portsInUse.delete(handle.port);
      throw new BrowserUnavailableError(
        'browser_start_failed',
        `Browser session ${sessionId} was torn down while starting.`,
      );
    }
    return this.adoptHandle(sessionId, workspaceId, handle);
  }

  /**
   * Shared registration tail for steel + native spawns (U7): adopt the live
   * handle into the registry entry, arm idle-reclaim, wire the exit listener
   * (Steel process death / shell view-crashed both land in handleProcessExit).
   */
  private adoptHandle(
    sessionId: string,
    workspaceId: string,
    handle: SteelProcessHandle | ShellViewHandle,
  ): BrowserSessionInfo {
    const current = this.registry.get(sessionId);
    if (!current) {
      throw new BrowserUnavailableError(
        'browser_start_failed',
        `Browser session ${sessionId} was torn down while starting.`,
      );
    }
    current.handle = handle;
    current.state = 'agent_in_control';
    current.startedAt = this.deps.now();
    // Fresh process — the first open() may inject a remembered site (U8).
    current.siteAuthEligible = true;
    // Arm the idle-reclaim prompt timer (U3): the clock starts now.
    current.lastActivityAt = this.deps.now();
    this.armIdlePrompt(sessionId);
    handle.onExit((info) => this.handleProcessExit(sessionId, handle, info));
    // A process that died between start() and here has already transitioned
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
  // Native spawn path (U7, KTD-6/KTD-10/KTD-11): the browser lives in the
  // shell (per-session partition view created over the control channel) or in
  // an operator-supplied external Chromium (R8/AE2, per-session throwaway
  // browser context). No Chromium resolution, no profile dirs, no pidfiles.
  // -------------------------------------------------------------------------

  private spawnNativeForSession(
    sessionId: string,
    workspaceId: string,
    viewerToken: string,
    target: BrowserCdpTarget & { kind: 'shell' | 'external' },
  ): Promise<BrowserSessionInfo> {
    const task = this.spawnQueue.then(async (): Promise<ShellViewHandle> => {
      // Same cap rule as the steel path (count OTHER live/starting sessions
      // inside the spawn mutex).
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
      return this.spawnExternalTarget(sessionId, workspaceId, marker, target);
    });
    const handleTask = task.then(async (handle) => {
      // Teardown raced the spawn — destroy the fresh view/target instead of
      // registering it (mirrors the steel path's race branch).
      const current = this.registry.get(sessionId);
      if (!current || current.expectingExit) {
        await handle.stop();
        throw new BrowserUnavailableError(
          'browser_start_failed',
          `Browser session ${sessionId} was torn down while starting.`,
        );
      }
      return this.adoptHandle(sessionId, workspaceId, handle);
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
        const entry = this.registry.get(sessionId);
        if (entry) {
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
    this.shellEventUnsubscribe = client.subscribeEvents((event: ShellViewEvent) => {
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
    });
  }

  private enqueueSpawn(
    sessionId: string,
    workspaceId: string,
    chromiumPath: string,
    viewerToken: string,
  ): Promise<SteelProcessHandle> {
    const task = this.spawnQueue.then(async () => {
      // Count OTHER sessions holding or building a process; this session's own
      // `starting` marker must not count against it (a session_lost rebuild is
      // still one browser). Two ensures racing past the outer check re-check
      // here, inside the mutex.
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

      const port = await this.allocateFreePort();
      this.portsInUse.add(port);
      const safeId = sanitizeSessionId(sessionId);
      // U7: point Steel's absolute viewer URLs (cast wsUrl) at the viewer
      // proxy with the session token as path prefix (KTD-7).
      const viewerDomain = this.deps.viewerDomain?.(viewerToken);
      const ignoreCertErrors = await this.deps.resolveIgnoreCertErrors();
      return this.deps.createProcess({
        sessionId,
        port,
        userDataDir: path.join(this.profilesDir(), safeId),
        chromiumPath,
        pidfilePath: path.join(this.runDir(), `${safeId}.json`),
        env: viewerDomain ? { DOMAIN: viewerDomain } : undefined,
        ignoreCertErrors,
      });
    });
    // Keep the queue alive across failures.
    this.spawnQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async allocateFreePort(): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const port = await this.deps.allocatePort();
      if (!this.portsInUse.has(port)) {
        return port;
      }
    }
    throw new Error('Failed to allocate a free loopback port for Steel');
  }

  private handleProcessExit(
    sessionId: string,
    handle: SteelProcessHandle | ShellViewHandle,
    info: SteelExitInfo,
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
    this.portsInUse.delete(handle.port);
    const reason =
      handle instanceof ShellViewHandle
        ? 'Browser view crashed or was destroyed (shell control channel event)'
        : `Steel process exited unexpectedly (code=${info.code}, signal=${info.signal})`;
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
      this.portsInUse.delete(handle.port);
    }
    if (options.wipeProfile) {
      if (handle instanceof ShellViewHandle) {
        // Native sessions: the wipeProfile semantic is the partition wipe over
        // the control channel (KTD-11); no profile dir exists.
        await handle.wipe();
      } else {
        // Per-session Chrome profile: session/workspace deletion wipes it (login
        // state on disk must not outlive the session; KTD-8 cascades land in U8).
        await rm(this.profileDirFor(entry.sessionId), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
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
      userDataDir: handle?.userDataDir ?? this.profileDirFor(entry.sessionId),
      startedAt: entry.startedAt,
    };
  }

  private profilesDir(): string {
    return path.join(this.deps.storageDir, 'browser', 'profiles');
  }

  private profileDirFor(sessionId: string): string {
    return path.join(this.profilesDir(), sanitizeSessionId(sessionId));
  }

  private runDir(): string {
    return path.join(this.deps.storageDir, 'browser', 'run');
  }
}

export const browserService = new BrowserService();
