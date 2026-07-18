import path from 'path';
import { rm } from 'fs/promises';
import { diagLog, diagWarn } from '../utils/diag-logger.js';
import { getStorageDir } from '../storage/data-dir.js';
import { resolveChromium } from '../utils/resolve-chromium.js';
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
 *  - closeRuntimesForWorkspace   -> handleRuntimesClosedForWorkspace(workspaceId)
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
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class BrowserService {
  private readonly deps: BrowserServiceDeps;
  private readonly registry = new Map<string, RegistryEntry>();
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

  getControlState(sessionId: string): BrowserControlState | undefined {
    return this.registry.get(sessionId)?.state;
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

    const starting = this.spawnForSession(sessionId, workspaceId, existing);
    const entry: RegistryEntry = existing ?? {
      sessionId,
      workspaceId,
      state: 'agent_in_control',
      handle: null,
      starting: null,
      expectingExit: false,
      startedAt: 0,
    };
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
  async teardownSession(sessionId: string): Promise<void> {
    const entry = this.registry.get(sessionId);
    if (!entry) return;
    this.registry.delete(sessionId);
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

  /**
   * Teardown path 3 (KTD-1): chatService.closeRuntimesForWorkspace ran. This
   * is the only runtime-close the browser reacts to — an ordinary runtime
   * close/rebuild must NOT tear the browser down (KTD-5 rebind semantics).
   * Idempotent twin of teardownWorkspace so both hook sites may call it.
   */
  async handleRuntimesClosedForWorkspace(workspaceId: string): Promise<void> {
    await this.teardownWorkspace(workspaceId);
  }

  /** Sidecar shutdown: SIGKILL every Steel tree within the 2s budget (KTD-1). */
  async shutdown(): Promise<void> {
    const entries = [...this.registry.values()];
    this.registry.clear();
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
    const handle = await this.enqueueSpawn(sessionId, workspaceId, chromiumPath);

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
      return this.deps.createProcess({
        sessionId,
        port,
        userDataDir: path.join(this.profilesDir(), safeId),
        chromiumPath,
        pidfilePath: path.join(this.runDir(), `${safeId}.json`),
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
