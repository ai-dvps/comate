import path from 'path';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { getStorageDir } from '../storage/data-dir.js';
import { resolveChromium } from '../utils/resolve-chromium.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import type { BrowserSessionContext } from '../models/workspace.js';
import { connectSteelPage } from './browser-cdp.js';
import { siteKeyForUrl } from './browser-site-key.js';
import { clearBrowserGateSession } from './browser-gate-state.js';
import { filterContextToScope, readSiteAuthEntry } from './browser-site-auth.js';
import { browserAuditService, type BrowserAuditService } from './browser-audit.js';
import {
  allocateLoopbackPort,
  cleanupStaleSteelProcesses,
  SteelProcess,
  type SteelExitInfo,
  type SteelProcessHandle,
  type SteelProcessOptions,
  type StaleCleanupReport,
} from './browser-steel-process.js';

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

export type BrowserServiceEvent =
  | BrowserStateEvent
  | BrowserClosedEvent
  | BrowserUnavailableEvent;

export type BrowserEventListener = (event: BrowserServiceEvent) => void;
export type PendingCardReleaser = (sessionId: string) => void;

export const DEFAULT_MAX_BROWSER_SESSIONS = 4;

interface RegistryEntry {
  sessionId: string;
  workspaceId: string;
  state: BrowserControlState;
  handle: SteelProcessHandle | null;
  starting: Promise<BrowserSessionInfo> | null;
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
  /** Audit sink for site-auth events; defaults to the process singleton. */
  audit?: Pick<BrowserAuditService, 'logSiteAuth'>;
}

/** Constructor-resolved deps: the U8 additions have defaults, so internally
 * they are always present (the public interface keeps them optional). */
type ResolvedBrowserServiceDeps = Omit<
  BrowserServiceDeps,
  'store' | 'currentPageUrl' | 'exportContext' | 'audit'
> &
  Required<Pick<BrowserServiceDeps, 'store' | 'currentPageUrl' | 'exportContext' | 'audit'>>;

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
  const page = await connectSteelPage(baseUrl, { commandTimeoutMs: 5_000 });
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

export class BrowserService {
  private readonly deps: ResolvedBrowserServiceDeps;
  private readonly registry = new Map<string, RegistryEntry>();
  /** token → sessionId for O(1) proxy lookups (kept in step with registry). */
  private readonly tokenIndex = new Map<string, string>();
  private readonly listeners = new Set<BrowserEventListener>();
  private readonly releasers = new Set<PendingCardReleaser>();
  /** Ports reserved by live, starting, or not-yet-reaped processes. */
  private readonly portsInUse = new Set<number>();
  private initPromise: Promise<void> | null = null;
  private spawnQueue: Promise<void> = Promise.resolve();

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
      exportContext: deps?.exportContext ?? exportSteelContext,
      audit: deps?.audit ?? browserAuditService,
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
        .catch((err) => {
          diagWarn('[browser] startup residue cleanup failed:', err);
        });
    }
    return this.initPromise;
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
   * The workspace a browser session belongs to, even when the process is
   * starting/lost (audit paths must keep working through crashes — U8).
   */
  getWorkspaceId(sessionId: string): string | undefined {
    return this.registry.get(sessionId)?.workspaceId;
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
    entry.state = state;
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
  async ensureSession(input: { sessionId: string; workspaceId: string }): Promise<BrowserSessionInfo> {
    await this.initialize();
    const { sessionId, workspaceId } = input;

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
  async teardownSession(sessionId: string): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    this.registry.delete(sessionId);
    this.tokenIndex.delete(entry.viewerToken);
    // The canUseTool-layer gate state (submit-semantics refs + navigation
    // ledger) is session-scoped — it must die with the session.
    clearBrowserGateSession(sessionId);
    entry.expectingExit = true;
    await this.stopEntry(entry, { wipeProfile: true });
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
  async rememberCurrentSite(sessionId: string): Promise<RememberSiteResult> {
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
    const storageDomainCount =
      Object.keys(scoped.localStorage ?? {}).length +
      Object.keys(scoped.sessionStorage ?? {}).length;
    if (scoped.cookies.length === 0 && storageDomainCount === 0) {
      throw new BrowserSiteAuthError(
        'empty_context',
        `No login state for ${keyResult.key} was found in the browser — log in first, then remember the site.`,
      );
    }

    const now = new Date().toISOString();
    const workspace = await this.deps.store.get(entry.workspaceId);
    const existing = workspace ? readSiteAuthEntry(workspace.settings ?? {}, keyResult.key) : undefined;
    const updated = this.deps.store.setWorkspaceSiteAuthEntry(entry.workspaceId, keyResult.key, {
      sessionContext: scoped,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (!updated) {
      throw new BrowserSiteAuthError(
        'export_failed',
        'The workspace no longer exists — the site could not be remembered.',
      );
    }
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
    const siteAuthEntry = workspace
      ? readSiteAuthEntry(workspace.settings ?? {}, keyResult.key)
      : undefined;
    if (!siteAuthEntry) return null;
    const now = new Date().toISOString();
    this.deps.store.setWorkspaceSiteAuthEntry(entry.workspaceId, keyResult.key, {
      ...siteAuthEntry,
      lastUsedAt: now,
    });
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
    const entries = [...this.registry.values()];
    this.registry.clear();
    this.tokenIndex.clear();
    for (const entry of entries) {
      entry.expectingExit = true;
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
        'No Chromium executable available (install Chrome/Edge, set COMATE_CHROMIUM_PATH, ' +
          'or allow the pinned download).',
      );
    }

    // Critical section: cap re-check + port reservation + child creation. The
    // reserved port stays in portsInUse until the process stops, so concurrent
    // spawns can never double-allocate (KTD-1 dynamic ports).
    const handle = await this.enqueueSpawn(sessionId, workspaceId, chromiumPath, viewerToken);

    try {
      await handle.start();
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

    current.handle = handle;
    current.state = 'agent_in_control';
    current.startedAt = this.deps.now();
    // Fresh process — the first open() may inject a remembered site (U8).
    current.siteAuthEligible = true;
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
      return this.deps.createProcess({
        sessionId,
        port,
        userDataDir: path.join(this.profilesDir(), safeId),
        chromiumPath,
        pidfilePath: path.join(this.runDir(), `${safeId}.json`),
        env: viewerDomain ? { DOMAIN: viewerDomain } : undefined,
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
    handle: SteelProcessHandle,
    info: SteelExitInfo,
  ): void {
    const entry = this.registry.get(sessionId);
    if (!entry || entry.handle !== handle || entry.expectingExit) {
      return;
    }
    entry.handle = null;
    entry.state = 'session_lost';
    this.portsInUse.delete(handle.port);
    const reason = `Steel process exited unexpectedly (code=${info.code}, signal=${info.signal})`;
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
    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      await handle.stop();
      this.portsInUse.delete(handle.port);
    }
    if (options.wipeProfile) {
      // Per-session Chrome profile: session/workspace deletion wipes it (login
      // state on disk must not outlive the session; KTD-8 cascades land in U8).
      await rm(this.profileDirFor(entry.sessionId), { recursive: true, force: true }).catch(
        () => undefined,
      );
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
