/**
 * U1 (KTD-1): sidecar lifecycle for the Electron shell — a behavioral port of
 * the legacy Tauri shell's `lib.rs` (spawn env at L503-546, stdout ready-line
 * parse at L555-580, shutdown matrix at L143-212, annotated "verified, reuse";
 * the Tauri tree was retired in U9).
 *
 * The sidecar contract is shell-agnostic: spawn the packaged binary via
 * `child_process.spawn` (NOT `utilityProcess` — the pkg-produced binary is a
 * Node-ABI executable, not an Electron utility process), pass the exact env
 * set, parse one stdout JSON line `{type:'ready', port, desktopToken}`, and
 * on quit run POST /shutdown → grace sleep → kill (tree-kill on Windows).
 *
 * This module deliberately avoids importing `electron` so the logic is
 * unit-testable under plain node:test (see sidecar.test.ts).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export interface SidecarReadyMessage {
  port: number;
  desktopToken?: string | undefined;
}

/**
 * Parse one stdout line for the sidecar ready handshake emitted by
 * `src/server/server-main.ts`. Returns null for any other line. The caller
 * must never log a line that parses as ready — it carries the per-boot
 * desktop GUI credential.
 */
export function parseSidecarReadyLine(line: string): SidecarReadyMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const record = msg as Record<string, unknown>;
  if (record['type'] !== 'ready') return null;
  const port = record['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  const token = record['desktopToken'];
  return { port, desktopToken: typeof token === 'string' && token.length > 0 ? token : undefined };
}

/**
 * Quit paths, mirroring lib.rs:
 *  - 'tray-quit' / 'window-destroyed' → perform_shutdown: flat 2s grace.
 *  - 'exit-requested' → cleanup_before_exit: 500ms, extended to 5s while an
 *    update install is pending (prepare_updater_relaunch armed the flag).
 */
export type ShutdownReason = 'tray-quit' | 'window-destroyed' | 'exit-requested';

export function selectShutdownGraceMs(reason: ShutdownReason, isUpdating: boolean): number {
  if (reason === 'exit-requested') {
    return isUpdating ? 5000 : 500;
  }
  return 2000;
}

/**
 * The exact env set the Tauri shell passed to the sidecar (lib.rs:534-538).
 * `TAURI_RESOURCE_DIR` keeps its name on purpose — six server-side resolvers
 * consume it (KTD-13).
 *
 * TODO(U1 follow-up, plan Risks: "Windows 关机/注销不触发 before-quit/will-quit"):
 * the sidecar has no parent-death watchdog today, so no parent-PID env is
 * passed. Once the sidecar learns to poll a parent PID (and/or the shell
 * wires a Windows Job Object with KILL_ON_JOB_CLOSE), add the env here —
 * without it a Windows shutdown/logout can orphan the sidecar.
 */
export function buildSidecarEnv(opts: {
  dataDir: string;
  resourceDir: string;
  /** U7 (KTD-6/KTD-11): in-shell Chromium CDP + control channel coordinates. */
  shellDebugPort?: number | undefined;
  shellControlPort?: number | undefined;
  shellControlToken?: string | undefined;
}): Record<string, string> {
  return {
    COMATE_DATA_DIR: opts.dataDir,
    TAURI_RESOURCE_DIR: opts.resourceDir,
    PORT: '0',
    COMATE_SIDECAR: '1',
    ...(opts.shellDebugPort ? { COMATE_SHELL_DEBUG_PORT: String(opts.shellDebugPort) } : {}),
    ...(opts.shellControlPort ? { COMATE_SHELL_CONTROL_PORT: String(opts.shellControlPort) } : {}),
    ...(opts.shellControlToken ? { COMATE_SHELL_CONTROL_TOKEN: opts.shellControlToken } : {}),
  };
}

/** Mirror of `getHostTriple()` in scripts/build-sidecar.ts. */
export function resolveSidecarTriple(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export interface SidecarPathEnv {
  isPackaged: boolean;
  /** `process.resourcesPath` (packaged) — unused in dev. */
  resourcesPath: string;
  /** Repo root in dev (`app.getAppPath()`). */
  repoRoot: string;
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * Dev: the `build/sidecar/sidecar-node-<triple>` staging layout
 * scripts/build-sidecar.ts produces. Packaged: `sidecar-node[.exe]` at the
 * root of `process.resourcesPath`, staged there via electron-builder
 * extraResources (U3; binaries must stay out of the asar).
 */
export function resolveSidecarBinaryPath(env: SidecarPathEnv): string {
  if (env.isPackaged) {
    const ext = env.platform === 'win32' ? '.exe' : '';
    return join(env.resourcesPath, `sidecar-node${ext}`);
  }
  const triple = resolveSidecarTriple(env.platform, env.arch);
  const ext = env.platform === 'win32' ? '.exe' : '';
  return join(env.repoRoot, 'build', 'sidecar', `sidecar-node-${triple}${ext}`);
}

/**
 * `TAURI_RESOURCE_DIR` points at the directory that directly contains
 * `claude/`, `rg`, `claude-code-plugin/`, … (server resolvers append those
 * names). Dev: the repo's `resources/` staging tree (U9: re-homed from the
 * retired Tauri tree). Packaged: the same tree staged under
 * `<resourcesPath>/resources` (U3 extraResources).
 */
export function resolveResourceDir(env: Pick<SidecarPathEnv, 'isPackaged' | 'resourcesPath' | 'repoRoot'>): string {
  return env.isPackaged
    ? join(env.resourcesPath, 'resources')
    : join(env.repoRoot, 'resources');
}

// ---------------------------------------------------------------------------
// Spawn / shutdown wiring
// ---------------------------------------------------------------------------

export interface ShellLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn?(message: string): void;
  error(message: string): void;
}

export interface SpawnSidecarOptions {
  binaryPath: string;
  args?: string[];
  /** Extra env merged over `process.env` (see buildSidecarEnv). */
  env: Record<string, string>;
  logger: ShellLogger;
  /** Ready-handshake deadline; the app shows a fatal error when it trips. */
  readyTimeoutMs?: number;
  /** Mirror non-ready stdout lines into the log (Tauri: debug builds only). */
  debugStdout?: boolean;
  onStdoutLine?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawnImpl?: typeof spawn;
}

export interface SidecarHandle {
  readonly child: ChildProcess | null;
  readonly ready: Promise<SidecarReadyMessage>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function spawnSidecar(options: SpawnSidecarOptions): SidecarHandle {
  const spawnImpl = options.spawnImpl ?? spawn;
  const spawnOpts: SpawnOptions = {
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };

  let child: ChildProcess;
  try {
    child = spawnImpl(options.binaryPath, options.args ?? [], spawnOpts);
  } catch (err) {
    // Synchronous spawn failures (rare; most surface as the 'error' event).
    return {
      child: null,
      ready: Promise.reject(
        new Error(`Failed to spawn sidecar at ${options.binaryPath}: ${String(err)}`),
      ),
    };
  }

  const logger = options.logger;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const ready = new Promise<SidecarReadyMessage>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Sidecar ready handshake timed out after ${readyTimeoutMs}ms ` +
              `(binary: ${options.binaryPath})`,
          ),
        ),
      );
    }, readyTimeoutMs);
    // Never let the handshake timer keep the process alive on its own.
    timeout.unref?.();

    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');

        const readyMsg = parseSidecarReadyLine(line);
        if (readyMsg) {
          // The ready line carries the desktop GUI credential — never log it.
          settle(() => resolve(readyMsg));
          continue;
        }
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          if (options.debugStdout) logger.debug?.(`Sidecar stdout: ${trimmed}`);
          options.onStdoutLine?.(trimmed);
        }
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
      let newlineIndex = stderrBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex).trim();
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        newlineIndex = stderrBuffer.indexOf('\n');
        if (line.length > 0) logger.error(`Sidecar stderr: ${line}`);
      }
    });

    child.on('error', (err) => {
      settle(() =>
        reject(new Error(`Failed to spawn sidecar at ${options.binaryPath}: ${err.message}`)),
      );
    });

    child.on('exit', (code, signal) => {
      logger.info(`Sidecar terminated: code=${String(code)} signal=${String(signal)}`);
      settle(() =>
        reject(
          new Error(
            `Sidecar exited before ready (code=${String(code)}, signal=${String(signal)}; ` +
              `binary: ${options.binaryPath})`,
          ),
        ),
      );
      options.onExit?.(code, signal);
    });
  });

  return { child, ready };
}

export interface ShutdownSidecarOptions {
  /** Bound sidecar port; null/undefined when the handshake never completed. */
  port: number | null | undefined;
  /** Grace between the /shutdown request and the force kill. */
  graceMs: number;
  logger: ShellLogger;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  // Ref'd on purpose: during quit we WANT the grace sleep to hold the process
  // until it resolves (an unref'd timer here also breaks node:test's
  // event-loop liveness detection in unit tests).
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The verified kill matrix (lib.rs:143-212): POST `http://127.0.0.1:<port>/shutdown`
 * with a 1s timeout, sleep the grace period, then force-kill. Windows kills
 * the whole tree (`taskkill /PID <pid> /T /F`) because the sidecar spawns
 * children of its own. Safe to call when the sidecar already exited.
 */
export async function shutdownSidecar(
  handle: SidecarHandle,
  options: ShutdownSidecarOptions,
): Promise<void> {
  const { logger } = options;
  const sleep = options.sleepImpl ?? defaultSleep;

  if (options.port != null) {
    const url = `http://127.0.0.1:${options.port}/shutdown`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      timeout.unref?.();
      try {
        await (options.fetchImpl ?? fetch)(url, { method: 'POST', signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      // The sidecar may already be gone; the force-kill below is the backstop.
      logger.debug?.(`Sidecar /shutdown request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Give Node time to clean up before force-killing.
    await sleep(options.graceMs);
  }

  const child = handle.child;
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    // Tree kill: the sidecar spawns its own children (CLI backends, rg).
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', () => resolve());
      killer.on('error', (err) => {
        logger.error(`Failed to taskkill sidecar: ${err.message}`);
        resolve();
      });
    });
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch (err) {
    logger.error(`Failed to kill sidecar: ${err instanceof Error ? err.message : String(err)}`);
  }
}
