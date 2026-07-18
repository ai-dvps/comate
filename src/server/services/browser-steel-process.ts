import path from 'path';
import { fileURLToPath } from 'url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { promisify } from 'util';
import { diagLog, diagWarn } from '../utils/diag-logger.js';

const execFileAsync = promisify(execFile);

/**
 * Low-level orchestration of one vendored-Steel child process (KTD-1/KTD-2).
 *
 * Re-exec-self: the packaged sidecar is a single-entry binary, so a Steel
 * child is spawned as `process.execPath` with `COMATE_STEEL=1` — the server
 * entrypoint (src/server/index.ts) then hosts the vendored Steel API instead
 * of the sidecar API. In dev (node/tsx) the same trick needs the entrypoint
 * script and the current loader flags (`process.execArgv`).
 *
 * Lifecycle discipline (KTD-1):
 *  - Steel ignores SIGTERM (U2 probe), so teardown is SIGKILL on the whole
 *    process group (POSIX `detached` + `kill(-pid)`), with a 2s budget
 *    matching the Rust shell's graceful window. Windows has no POSIX process
 *    groups; `taskkill /T /F` is the best-effort equivalent.
 *  - Every spawn writes a pidfile (`{pid, port, sessionId}`) into the run
 *    directory so the next sidecar boot can reap orphans left behind by a
 *    force-killed sidecar (`cleanupStaleSteelProcesses`).
 *  - Steel API + Chromium CDP stay on loopback: HOST is always 127.0.0.1
 *    (KTD-7) and the health probe only talks to 127.0.0.1.
 */

export interface SteelSpawnSpec {
  command: string;
  args: string[];
}

export interface SteelPidfile {
  pid: number;
  port: number;
  sessionId: string;
  startedAt: string;
}

export interface SteelProcessOptions {
  sessionId: string;
  /** Pre-allocated loopback port Steel listens on (PORT env). */
  port: number;
  /** Per-session Chrome profile dir (CHROME_USER_DATA_DIR). */
  userDataDir: string;
  /** Resolved Chromium executable (CHROME_EXECUTABLE_PATH), when available. */
  chromiumPath?: string;
  /** Pidfile location for crash-residue cleanup. */
  pidfilePath: string;
  /** Extra environment overrides for the child. */
  env?: Record<string, string>;
}

export interface SteelProcessDeps {
  spawnSpec: () => SteelSpawnSpec;
  spawnImpl: typeof spawn;
  fetchImpl: typeof fetch;
  /** Overall budget for the readiness probe (Chrome cold start included). */
  healthTimeoutMs: number;
  healthIntervalMs: number;
  /** Stop budget — the Rust shell allows ~2s before force-kill (KTD-1). */
  stopTimeoutMs: number;
  /** Per-request probe timeout. */
  probeTimeoutMs: number;
  now: () => number;
}

export interface SteelExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Handle the browser-service (and tests) drive a Steel child through. */
export interface SteelProcessHandle {
  readonly sessionId: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number | undefined;
  readonly userDataDir: string;
  start(): Promise<void>;
  /** SIGKILL the process group within the stop budget; idempotent. */
  stop(): Promise<void>;
  probeHealth(): Promise<boolean>;
  /** Register an exit listener; returns an unsubscribe function. */
  onExit(listener: (info: SteelExitInfo) => void): () => void;
}

export class SteelStartError extends Error {
  constructor(
    message: string,
    readonly outputTail?: string,
  ) {
    super(message);
    this.name = 'SteelStartError';
  }
}

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_INTERVAL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const OUTPUT_TAIL_LIMIT = 4_000;

function defaultDeps(): SteelProcessDeps {
  return {
    spawnSpec: resolveSteelSpawnSpec,
    spawnImpl: spawn,
    fetchImpl: fetch,
    healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
    healthIntervalMs: DEFAULT_HEALTH_INTERVAL_MS,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    now: () => Date.now(),
  };
}

/**
 * Resolve how to launch the Steel leg of this binary (re-exec-self, KTD-2).
 * Packaged sidecar (pkg): the executable IS the app — spawn it bare. Dev /
 * tsx / plain node: re-exec the same runtime (loader flags included) against
 * the server entrypoint script, mirroring steel-entrypoint.test.ts.
 */
export function resolveSteelSpawnSpec(): SteelSpawnSpec {
  if ((process as { pkg?: unknown }).pkg) {
    return { command: process.execPath, args: [] };
  }
  let moduleDir: string | undefined;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // import.meta.url unavailable (bundler shim); fall through to argv[1].
  }
  const candidates = moduleDir
    ? [
        path.join(moduleDir, '..', 'index.ts'),
        path.join(moduleDir, '..', 'index.js'),
      ]
    : [];
  const entry = candidates.find((candidate) => existsSync(candidate)) ?? process.argv[1];
  return { command: process.execPath, args: [...process.execArgv, entry] };
}

/** Allocate an OS-assigned free port on loopback. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGKILL the whole process tree rooted at `pid`. POSIX relies on the child
 * having been spawned `detached` (its own process group); Windows falls back
 * to `taskkill /T /F` (best-effort, KTD-1).
 */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: 5_000,
      });
    } catch {
      // Already dead, or taskkill unavailable — best-effort per KTD-1.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Group and process both gone.
      }
      return;
    }
    // EPERM: not our group — fall back to the single process.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SteelProcess implements SteelProcessHandle {
  readonly sessionId: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly userDataDir: string;
  private readonly options: SteelProcessOptions;
  private readonly deps: SteelProcessDeps;
  private child: ChildProcess | null = null;
  private exitInfo: SteelExitInfo | null = null;
  private exitListeners = new Set<(info: SteelExitInfo) => void>();
  private outputTail = '';

  constructor(options: SteelProcessOptions, deps?: Partial<SteelProcessDeps>) {
    this.options = options;
    this.deps = { ...defaultDeps(), ...deps };
    this.sessionId = options.sessionId;
    this.port = options.port;
    this.baseUrl = `http://127.0.0.1:${options.port}`;
    this.userDataDir = options.userDataDir;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  onExit(listener: (info: SteelExitInfo) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error(`Steel process for session ${this.sessionId} already started`);
    }
    const spec = this.deps.spawnSpec();
    mkdirSync(this.userDataDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COMATE_STEEL: '1',
      HOST: '127.0.0.1',
      PORT: String(this.port),
      CHROME_USER_DATA_DIR: this.userDataDir,
      ...this.options.env,
    };
    if (this.options.chromiumPath) {
      env.CHROME_EXECUTABLE_PATH = this.options.chromiumPath;
    }

    const child = this.deps.spawnImpl(spec.command, spec.args, {
      env,
      // Own process group on POSIX so teardown can SIGKILL the whole tree
      // (Steel ignores SIGTERM, and Chromium re-parents its helpers).
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk) => this.rememberOutput(chunk));
    child.stderr?.on('data', (chunk) => this.rememberOutput(chunk));
    child.on('error', (err) => {
      // Spawn-level failure (binary vanished, EMFILE, ...) may never produce an
      // 'exit' event — treat it as one so health waits and stop() don't stall.
      diagWarn(`[steel] spawn error for session ${this.sessionId}:`, err.message);
      this.markExited({ code: null, signal: null });
    });
    child.on('exit', (code, signal) => {
      this.markExited({ code, signal });
    });

    // Write the pidfile immediately so even a hung child is tracked for the
    // next boot's residue cleanup.
    this.writePidfile();

    try {
      await this.waitForHealthy();
    } catch (err) {
      await this.killChild();
      this.removePidfile();
      throw err;
    }
    diagLog(
      `[steel] session ${this.sessionId} ready on ${this.baseUrl} (pid ${this.pid ?? 'unknown'})`,
    );
  }

  async probeHealth(): Promise<boolean> {
    try {
      const res = await this.deps.fetchImpl(`${this.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(this.deps.probeTimeoutMs),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.removePidfile();
      return;
    }
    if (!this.exitInfo) {
      await this.killChild();
    }
    this.removePidfile();
    this.child = null;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || this.exitInfo) return;
    const pid = child.pid;
    if (pid !== undefined) {
      await killProcessTree(pid);
    }
    if (this.exitInfo) return;
    // SIGKILL is near-instant, but stay within the 2s budget even if the
    // exit event never arrives (KTD-1: no graceful negotiation).
    const deadline = this.deps.now() + this.deps.stopTimeoutMs;
    while (!this.exitInfo && this.deps.now() < deadline) {
      await sleep(25);
    }
    if (!this.exitInfo) {
      diagWarn(
        `[steel] session ${this.sessionId} did not report exit within ${this.deps.stopTimeoutMs}ms of SIGKILL`,
      );
    }
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = this.deps.now() + this.deps.healthTimeoutMs;
    while (this.deps.now() < deadline) {
      if (this.exitInfo) {
        throw new SteelStartError(
          `Steel process for session ${this.sessionId} exited during startup ` +
            `(code=${this.exitInfo.code}, signal=${this.exitInfo.signal})`,
          this.outputTail,
        );
      }
      if (await this.probeHealth()) {
        return;
      }
      await sleep(this.deps.healthIntervalMs);
    }
    throw new SteelStartError(
      `Steel process for session ${this.sessionId} did not become healthy within ` +
        `${this.deps.healthTimeoutMs}ms`,
      this.outputTail,
    );
  }

  private rememberOutput(chunk: Buffer | string): void {
    this.outputTail = (this.outputTail + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
  }

  private markExited(info: SteelExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    const listeners = [...this.exitListeners];
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (err) {
        diagWarn('[steel] exit listener threw:', err);
      }
    }
  }

  private writePidfile(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      mkdirSync(path.dirname(this.options.pidfilePath), { recursive: true });
      const record: SteelPidfile = {
        pid,
        port: this.port,
        sessionId: this.sessionId,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(this.options.pidfilePath, JSON.stringify(record, null, 2));
    } catch (err) {
      diagWarn(`[steel] failed to write pidfile ${this.options.pidfilePath}:`, err);
    }
  }

  private removePidfile(): void {
    try {
      rmSync(this.options.pidfilePath, { force: true });
    } catch {
      // Best-effort; a stale pidfile is reaped by the next boot's cleanup.
    }
  }
}

export interface StaleCleanupDeps {
  fetchImpl: typeof fetch;
  killTree: (pid: number) => Promise<void>;
  probeTimeoutMs: number;
  settleTimeoutMs: number;
}

export interface StaleCleanupReport {
  scanned: number;
  killed: number;
  removed: number;
  skipped: number;
}

function defaultStaleCleanupDeps(): StaleCleanupDeps {
  return {
    fetchImpl: fetch,
    killTree: killProcessTree,
    probeTimeoutMs: 800,
    settleTimeoutMs: 1_000,
  };
}

/**
 * Reap Steel children orphaned by a previous sidecar (force-kill never runs
 * /shutdown). A pidfile whose pid is dead is just removed. A pidfile whose
 * port still serves HTTP means the old Steel (or, theoretically, an
 * unfortunate pid+port reuse) is alive — SIGKILL its process group. A live
 * pid with nothing on the recorded port is left alone (possible pid reuse)
 * and its pidfile dropped with a loud log; the orphan window is the ~1s
 * between spawn and fastify bind, accepted per KTD-1 best-effort.
 */
export async function cleanupStaleSteelProcesses(
  runDir: string,
  overrides?: Partial<StaleCleanupDeps>,
): Promise<StaleCleanupReport> {
  const deps = { ...defaultStaleCleanupDeps(), ...overrides };
  const report: StaleCleanupReport = { scanned: 0, killed: 0, removed: 0, skipped: 0 };
  let files: string[] = [];
  try {
    files = readdirSync(runDir).filter((name) => name.endsWith('.json'));
  } catch {
    return report; // No run dir — nothing to reap.
  }

  for (const file of files) {
    report.scanned += 1;
    const pidfilePath = path.join(runDir, file);
    let record: SteelPidfile | undefined;
    try {
      record = JSON.parse(readFileSync(pidfilePath, 'utf-8')) as SteelPidfile;
    } catch {
      diagWarn(`[steel] removing unreadable pidfile ${pidfilePath}`);
      rmSync(pidfilePath, { force: true });
      report.removed += 1;
      continue;
    }
    if (!record || typeof record.pid !== 'number' || typeof record.port !== 'number') {
      rmSync(pidfilePath, { force: true });
      report.removed += 1;
      continue;
    }

    if (!isPidAlive(record.pid)) {
      rmSync(pidfilePath, { force: true });
      report.removed += 1;
      continue;
    }

    let portServes = false;
    try {
      // Any HTTP status (Steel answers 503 until its browser is up) proves a
      // server still holds the recorded port.
      await deps.fetchImpl(`http://127.0.0.1:${record.port}/v1/health`, {
        signal: AbortSignal.timeout(deps.probeTimeoutMs),
      });
      portServes = true;
    } catch {
      portServes = false;
    }

    if (!portServes) {
      diagWarn(
        `[steel] pid ${record.pid} (session ${record.sessionId}) alive but port ${record.port} ` +
          'not serving; assuming pid reuse and dropping pidfile',
      );
      rmSync(pidfilePath, { force: true });
      report.skipped += 1;
      continue;
    }

    diagLog(
      `[steel] reaping orphaned Steel process pid=${record.pid} port=${record.port} ` +
        `(session ${record.sessionId})`,
    );
    await deps.killTree(record.pid);
    const deadline = Date.now() + deps.settleTimeoutMs;
    while (isPidAlive(record.pid) && Date.now() < deadline) {
      await sleep(25);
    }
    rmSync(pidfilePath, { force: true });
    report.killed += 1;
  }
  return report;
}
