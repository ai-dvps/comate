/**
 * sandbox-probe — spawn-time probe state machine for the bot execution
 * sandbox (U3, KTD-24).
 *
 * The SDK sandbox is the execution boundary the new bot permission model
 * relies on (R1/R2). When the host cannot actually enforce it (Windows, Linux
 * without bubblewrap, Ubuntu 24.04 AppArmor blocking bwrap, a broken seatbelt
 * profile) the permission posture must degrade loudly instead of silently
 * running unsandboxed:
 *
 * - probe PASSES  → bot sessions pin `failIfUnavailable: true` (a session
 *   that cannot start its sandbox errors out rather than running bare).
 * - probe FAILS   → degraded posture: structural rules + role-routed gate
 *   (normal unmatched bash denies, owner/admin retain their role bypass, R5),
 *   `failIfUnavailable: false`, an audit line, and a desktop-visible
 *   persistent banner fed by /api/health/sandbox.
 *
 * The probe uses NEGATIVE assertions — it never trusts that a mechanism
 * exists, only that a denial is enforced:
 *   1. a path denied by the sandbox profile is genuinely unreadable, and
 *   2. a non-allowlisted canary domain is genuinely unreachable.
 * Positive controls (same read without the deny rule) distinguish "deny
 * enforced" from "the sandbox binary itself failed to start".
 *
 * Results are cached process-wide with a short TTL: the probe spawns helper
 * processes, so per-spawn cost is paid at most once per TTL window (first bot
 * runtime creation in a window) rather than on every runtime creation.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagLog } from '../utils/diag-logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxProbeResult {
  ok: boolean;
  platform: string;
  /** Stable machine-checkable failure codes (e.g. 'filesystem-deny-not-enforced'). */
  failures: string[];
  checkedAt: number;
  durationMs: number;
}

export interface ProbeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process failed to spawn or was killed on timeout. */
  error?: string;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<ProbeRunResult>;

export interface SandboxProbeDeps {
  /** Defaults to process.platform. */
  platform?: string;
  /** Defaults to a spawn-based runner. */
  runner?: ProbeRunner;
  /**
   * Directory containing `canary.txt` with known content. Created (and
   * removed afterwards) when omitted. Injected in tests.
   */
  canaryDir?: string;
  /** Node binary used for the network assertion. Defaults to process.execPath. */
  nodePath?: string;
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_CACHE_TTL_MS = 60_000;
const CANARY_FILE = 'canary.txt';
const CANARY_CONTENT = 'comate-sandbox-probe-canary';
/** Resolvable host: if the network deny is broken AND egress works, the connect succeeds and we detect it. */
const CANARY_HOST = 'example.com';
const CANARY_PORT = 443;

// ---------------------------------------------------------------------------
// Default spawn runner
// ---------------------------------------------------------------------------

const defaultRunner: ProbeRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProbeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish({ code: null, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Script executed with the node binary for the network negative assertion.
 * Exit 0 only when the canary host actually connects (isolation broken);
 * exit 1 on DNS failure, connect failure, or timeout.
 */
const NET_ASSERT_SCRIPT = [
  "const s=require('net').connect({host:process.argv[1],port:Number(process.argv[2]),timeout:2000});",
  "s.on('connect',()=>process.exit(0));",
  "s.on('timeout',()=>{s.destroy();process.exit(1)});",
  "s.on('error',()=>process.exit(1));",
].join('');

interface AssertionContext {
  runner: ProbeRunner;
  nodePath: string;
  canaryDirReal: string;
  canaryFile: string;
}

async function assertDarwin(ctx: AssertionContext, failures: string[]): Promise<void> {
  const seatbelt = '/usr/bin/sandbox-exec';
  const allowAll = '(version 1)(allow default)';

  // Positive control: seatbelt runs at all and the canary is readable.
  const control = await ctx.runner(seatbelt, ['-p', allowAll, '/bin/cat', ctx.canaryFile], PROBE_TIMEOUT_MS);
  if (control.error || control.code !== 0 || !control.stdout.includes(CANARY_CONTENT)) {
    failures.push('seatbelt-exec-failed');
    return;
  }

  // The FS and NET negative assertions are independent — run them
  // concurrently, then evaluate in fixed order (fs first, then net): the
  // failures array order is asserted in tests.
  const [fsDeny, netDeny] = await Promise.all([
    // FS negative assertion: a denied path must be unreadable.
    ctx.runner(
      seatbelt,
      ['-p', `${allowAll}(deny file-read* (subpath "${ctx.canaryDirReal}"))`, '/bin/cat', ctx.canaryFile],
      PROBE_TIMEOUT_MS,
    ),
    // NET negative assertion: with outbound denied the canary host must be unreachable.
    ctx.runner(
      seatbelt,
      ['-p', `${allowAll}(deny network-outbound)`, ctx.nodePath, '-e', NET_ASSERT_SCRIPT, CANARY_HOST, String(CANARY_PORT)],
      PROBE_TIMEOUT_MS,
    ),
  ]);
  if (!fsDeny.error && fsDeny.code === 0 && fsDeny.stdout.includes(CANARY_CONTENT)) {
    failures.push('filesystem-deny-not-enforced');
  }
  if (!netDeny.error && netDeny.code === 0) {
    failures.push('network-deny-not-enforced');
  }
}

async function assertLinux(ctx: AssertionContext, failures: string[]): Promise<void> {
  const version = await ctx.runner('bwrap', ['--version'], PROBE_TIMEOUT_MS);
  if (version.error || version.code !== 0) {
    failures.push('bubblewrap-missing');
    return;
  }

  // Positive control: bwrap starts and the canary is readable inside it.
  const control = await ctx.runner(
    'bwrap',
    ['--die-with-parent', '--ro-bind', '/', '/', '/bin/cat', ctx.canaryFile],
    PROBE_TIMEOUT_MS,
  );
  if (control.error || control.code !== 0 || !control.stdout.includes(CANARY_CONTENT)) {
    failures.push('bubblewrap-exec-failed');
    return;
  }

  // The FS and NET negative assertions are independent — run them
  // concurrently, then evaluate in fixed order (fs first, then net): the
  // failures array order is asserted in tests.
  const [fsDeny, netDeny] = await Promise.all([
    // FS negative assertion: masking the canary dir must make it unreadable.
    ctx.runner(
      'bwrap',
      ['--die-with-parent', '--ro-bind', '/', '/', '--tmpfs', ctx.canaryDirReal, '/bin/cat', ctx.canaryFile],
      PROBE_TIMEOUT_MS,
    ),
    // NET negative assertion: no network namespace → canary host unreachable.
    ctx.runner(
      'bwrap',
      ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', ctx.nodePath, '-e', NET_ASSERT_SCRIPT, CANARY_HOST, String(CANARY_PORT)],
      PROBE_TIMEOUT_MS,
    ),
  ]);
  if (!fsDeny.error && fsDeny.code === 0 && fsDeny.stdout.includes(CANARY_CONTENT)) {
    failures.push('filesystem-deny-not-enforced');
  }
  if (!netDeny.error && netDeny.code === 0) {
    failures.push('network-deny-not-enforced');
  }
}

/**
 * Run the probe once. Pure with respect to the injected deps — caching and
 * auditing live in ensureSandboxProbe below.
 */
export async function runSandboxProbe(deps: SandboxProbeDeps = {}): Promise<SandboxProbeResult> {
  const startedAt = Date.now();
  const platform = deps.platform ?? process.platform;
  const runner = deps.runner ?? defaultRunner;
  const nodePath = deps.nodePath ?? process.execPath;
  const failures: string[] = [];

  let canaryDir = deps.canaryDir;
  let createdCanary = false;
  try {
    if (platform !== 'darwin' && platform !== 'linux') {
      failures.push('platform-unsupported');
    } else {
      if (!canaryDir) {
        canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comate-sandbox-probe-'));
        createdCanary = true;
      }
      const canaryFile = path.join(canaryDir, CANARY_FILE);
      fs.writeFileSync(canaryFile, CANARY_CONTENT);
      // macOS /tmp is a symlink to /private/tmp; seatbelt matches canonical paths.
      const canaryDirReal = fs.realpathSync(canaryDir);
      const ctx: AssertionContext = { runner, nodePath, canaryDirReal, canaryFile };
      if (platform === 'darwin') {
        await assertDarwin(ctx, failures);
      } else {
        await assertLinux(ctx, failures);
      }
    }
  } catch (err) {
    failures.push(`probe-error:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (createdCanary && canaryDir) {
      try {
        fs.rmSync(canaryDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  return {
    ok: failures.length === 0,
    platform,
    failures,
    checkedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Cached state machine
// ---------------------------------------------------------------------------

let cachedProbe: SandboxProbeResult | null = null;
let inflightProbe: Promise<SandboxProbeResult> | null = null;
let probeOverride: (() => Promise<SandboxProbeResult>) | undefined;

/**
 * Ensure a fresh-enough probe result. Called at bot runtime creation (the
 * spawn seam, KTD-24) and by /api/health/sandbox. Results are cached for
 * PROBE_CACHE_TTL_MS so consecutive runtime creations in a window reuse one
 * probe; `forceRefresh` re-runs (the banner's re-check path, which is also
 * how a repaired host clears the degraded banner).
 */
export async function ensureSandboxProbe(options?: { forceRefresh?: boolean }): Promise<SandboxProbeResult> {
  if (
    !options?.forceRefresh &&
    cachedProbe &&
    Date.now() - cachedProbe.checkedAt < PROBE_CACHE_TTL_MS
  ) {
    return cachedProbe;
  }
  if (inflightProbe) return inflightProbe;
  inflightProbe = (async () => {
    const result = probeOverride ? await probeOverride() : await runSandboxProbe();
    const previous = cachedProbe;
    cachedProbe = result;
    if (!result.ok) {
      // Audit (KTD-24): degraded posture is a security-relevant state transition.
      diagLog(
        `[SandboxProbe] degraded posture: platform=${result.platform} failures=${result.failures.join(',')} durationMs=${result.durationMs}`,
      );
    } else if (previous && !previous.ok) {
      diagLog(`[SandboxProbe] recovered: platform=${result.platform} durationMs=${result.durationMs}`);
    } else {
      diagLog(`[SandboxProbe] ok: platform=${result.platform} durationMs=${result.durationMs}`);
    }
    return result;
  })().finally(() => {
    inflightProbe = null;
  });
  return inflightProbe;
}

/** Synchronous read of the cached probe state (null when never probed). */
export function getSandboxProbeState(): SandboxProbeResult | null {
  return cachedProbe;
}

/**
 * Whether the host is currently known to be in the degraded posture.
 * `null` state (never probed) is NOT degraded: bot sessions then pin
 * `failIfUnavailable: true`, so a genuinely broken sandbox hard-fails at the
 * SDK layer instead of silently bypassing.
 */
export function isSandboxDegraded(): boolean {
  return cachedProbe !== null && !cachedProbe.ok;
}

/** Test seam: stub the probe entirely. Clears the cache so the next ensure re-runs. */
export function __setSandboxProbeForTesting(
  override: (() => Promise<SandboxProbeResult>) | undefined,
): void {
  probeOverride = override;
  cachedProbe = null;
  inflightProbe = null;
}

/** Test seam: drop the cached result without touching the override. */
export function __resetSandboxProbeCacheForTesting(): void {
  cachedProbe = null;
  inflightProbe = null;
}
