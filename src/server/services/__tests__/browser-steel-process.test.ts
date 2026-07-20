import '../../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  allocateLoopbackPort,
  cleanupStaleSteelProcesses,
  reapStaleProfileLock,
  resolveSteelSpawnSpec,
  SteelProcess,
  SteelStartError,
  type SteelPidfile,
} from '../browser-steel-process.js';

/**
 * browser-steel-process tests use a real child process (the fake-steel
 * fixture) rather than mocks: the lifecycle contract being pinned down here —
 * spawn env, health probe, SIGKILL process-group teardown, pidfile residue —
 * is exactly the surface that breaks silently when faked.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-steel.cjs',
);

function fixtureSpawnSpec() {
  return { command: process.execPath, args: [FIXTURE] };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDeath(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

interface RunningFixture {
  proc: SteelProcess;
  port: number;
  pidfilePath: string;
  userDataDir: string;
}

describe('browser-steel-process', { concurrency: false }, () => {
  let workDir: string;
  let runDir: string;
  const running: RunningFixture[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'comate-steel-proc-test-'));
    runDir = path.join(workDir, 'run');
  });

  afterEach(async () => {
    // Belt-and-braces: no test may leak a live child or pidfile.
    for (const item of running.splice(0)) {
      await item.proc.stop().catch(() => undefined);
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  async function startFixture(
    sessionId: string,
    overrides?: { env?: Record<string, string>; healthTimeoutMs?: number },
  ): Promise<RunningFixture> {
    const port = await allocateLoopbackPort();
    const userDataDir = path.join(workDir, 'profiles', sessionId);
    const pidfilePath = path.join(runDir, `${sessionId}.json`);
    const proc = new SteelProcess(
      { sessionId, port, userDataDir, pidfilePath, env: overrides?.env },
      {
        spawnSpec: fixtureSpawnSpec,
        healthTimeoutMs: overrides?.healthTimeoutMs ?? 10_000,
        healthIntervalMs: 50,
      },
    );
    await proc.start();
    const item: RunningFixture = { proc, port, pidfilePath, userDataDir };
    running.push(item);
    return item;
  }

  it('spawns re-exec-self style, probes health, and stop() leaves no residue', async () => {
    const { proc, port, pidfilePath, userDataDir } = await startFixture('s1');

    // Healthy + registered
    assert.strictEqual(proc.baseUrl, `http://127.0.0.1:${port}`);
    assert.strictEqual(await proc.probeHealth(), true);
    const pid = proc.pid;
    assert.ok(pid && isPidAlive(pid), 'child process must be running');

    // Pidfile records pid + port for the next boot's residue cleanup
    const record = JSON.parse(readFileSync(pidfilePath, 'utf-8')) as SteelPidfile;
    assert.strictEqual(record.pid, pid);
    assert.strictEqual(record.port, port);
    assert.strictEqual(record.sessionId, 's1');

    // Profile dir was pre-created for Chrome
    assert.ok(existsSync(userDataDir));

    await proc.stop();
    assert.ok(await waitForPidDeath(pid!), 'child must be dead after stop()');
    assert.ok(!existsSync(pidfilePath), 'pidfile must be removed after stop()');
  });

  it('runs two processes concurrently on distinct ports bound to 127.0.0.1 only', async () => {
    const first = await startFixture('s1');
    const second = await startFixture('s2');

    assert.notStrictEqual(first.port, second.port);

    const probe = async (port: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      assert.strictEqual(res.status, 200);
      return (await res.json()) as { address: string; port: number };
    };

    const body1 = await probe(first.port);
    const body2 = await probe(second.port);
    assert.strictEqual(body1.address, '127.0.0.1');
    assert.strictEqual(body2.address, '127.0.0.1');
    assert.strictEqual(body1.port, first.port);
    assert.strictEqual(body2.port, second.port);
  });

  it('stop() SIGKILLs the whole process tree even when the child ignores SIGTERM', async () => {
    const childPidfile = path.join(workDir, 'chrome-standin.pid');
    const { proc } = await startFixture('s1', {
      env: { FAKE_STEEL_CHILD_PIDFILE: childPidfile },
    });
    const pid = proc.pid!;
    assert.ok(existsSync(childPidfile), 'fixture must spawn its Chrome stand-in');
    const grandchildPid = parseInt(readFileSync(childPidfile, 'utf-8'), 10);
    assert.ok(isPidAlive(grandchildPid));

    // Prove the fixture emulates Steel's SIGTERM resistance (U2 probe).
    process.kill(pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(isPidAlive(pid), 'fixture must ignore SIGTERM like the real Steel');

    await proc.stop();
    assert.ok(await waitForPidDeath(pid), 'parent must die from the group SIGKILL');
    assert.ok(
      await waitForPidDeath(grandchildPid),
      'Chrome stand-in (process-group member) must die with the parent',
    );
  });

  it('start() fails loudly and cleans up when the child never becomes healthy', async () => {
    const port = await allocateLoopbackPort();
    const pidfilePath = path.join(runDir, 'hung.json');
    const proc = new SteelProcess(
      {
        sessionId: 'hung',
        port,
        userDataDir: path.join(workDir, 'profiles', 'hung'),
        pidfilePath,
        env: { FAKE_STEEL_NEVER_HEALTHY: '1' },
      },
      { spawnSpec: fixtureSpawnSpec, healthTimeoutMs: 1_500, healthIntervalMs: 50 },
    );

    await assert.rejects(proc.start(), (err: unknown) => {
      assert.ok(err instanceof SteelStartError, `expected SteelStartError, got ${err}`);
      return true;
    });
    const childPid = proc.pid;
    if (childPid !== undefined) {
      assert.ok(await waitForPidDeath(childPid), 'hung child must be killed after start failure');
    }
    assert.ok(!existsSync(pidfilePath), 'pidfile must be removed after start failure');
  });

  it('resolveSteelSpawnSpec re-execs the current runtime against the server entrypoint', () => {
    const spec = resolveSteelSpawnSpec();
    assert.strictEqual(spec.command, process.execPath);
    const entry = spec.args[spec.args.length - 1];
    assert.ok(entry && existsSync(entry), `entrypoint must exist on disk: ${entry}`);
    assert.match(path.basename(entry), /^index\.(ts|js)$/);
  });

  it('allocateLoopbackPort returns a free loopback port', async () => {
    const port = await allocateLoopbackPort();
    assert.ok(port > 0 && port <= 65535);
    // The port must actually be bindable right now.
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });

  it('cleanupStaleSteelProcesses reaps an orphaned child via its pidfile', async () => {
    // Simulate a previous sidecar run: live fixture child + pidfile, but our
    // SteelProcess wrapper is gone (sidecar "died" without stop()).
    const port = await allocateLoopbackPort();
    const orphan = spawn(process.execPath, [FIXTURE], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    assert.ok(orphan.pid);
    try {
      // Wait for the orphan to bind its port.
      const deadline = Date.now() + 10_000;
      let healthy = false;
      while (Date.now() < deadline && !healthy) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
            signal: AbortSignal.timeout(500),
          });
          healthy = res.status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(healthy, 'orphan fixture must be serving before cleanup');

      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, 'orphan.json'),
        JSON.stringify({ pid: orphan.pid, port, sessionId: 'orphan', startedAt: '' }),
      );

      const report = await cleanupStaleSteelProcesses(runDir);
      assert.strictEqual(report.scanned, 1);
      assert.strictEqual(report.killed, 1);
      assert.ok(await waitForPidDeath(orphan.pid!), 'orphan must be SIGKILLed');
      assert.ok(!existsSync(path.join(runDir, 'orphan.json')), 'pidfile must be removed');
    } finally {
      if (orphan.pid && isPidAlive(orphan.pid)) {
        try {
          process.kill(process.platform === 'win32' ? orphan.pid : -orphan.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  it('cleanupStaleSteelProcesses removes pidfiles of dead processes and unreadable files', async () => {
    // A pid that is certainly dead: spawn and wait for exit, then reuse.
    const shortLived = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => shortLived.once('exit', resolve));
    const deadPid = shortLived.pid!;

    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'dead.json'),
      JSON.stringify({ pid: deadPid, port: 1, sessionId: 'dead', startedAt: '' }),
    );
    writeFileSync(path.join(runDir, 'garbage.json'), 'not json{');

    const report = await cleanupStaleSteelProcesses(runDir);
    assert.strictEqual(report.scanned, 2);
    assert.strictEqual(report.killed, 0);
    assert.strictEqual(report.removed, 2);
    assert.strictEqual(readdirSync(runDir).length, 0, 'run dir must be empty afterwards');
  });

  it('cleanupStaleSteelProcesses leaves a live pid alone when its port is not serving (pid reuse guard)', async () => {
    // Live process that is NOT a steel server, recorded with a free port.
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    assert.ok(bystander.pid);
    try {
      const freePort = await allocateLoopbackPort();
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, 'bystander.json'),
        JSON.stringify({ pid: bystander.pid, port: freePort, sessionId: 'x', startedAt: '' }),
      );

      const report = await cleanupStaleSteelProcesses(runDir);
      assert.strictEqual(report.killed, 0);
      assert.strictEqual(report.skipped, 1);
      assert.ok(isPidAlive(bystander.pid!), 'unrelated process must not be killed');
      assert.ok(!existsSync(path.join(runDir, 'bystander.json')));
    } finally {
      if (bystander.pid) {
        try {
          process.kill(bystander.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });
});

describe('reapStaleProfileLock', { concurrency: false }, () => {
  function writeLock(profileDir: string, pid: number): void {
    // Chrome POSIX SingletonLock is a symlink "<hostname>-<pid>" whose target
    // does not exist on disk (the target name encodes host+pid only).
    symlinkSync(`reap-test-host-${pid}`, path.join(profileDir, 'SingletonLock'));
    writeFileSync(path.join(profileDir, 'SingletonCookie'), '');
    writeFileSync(path.join(profileDir, 'SingletonSocket'), '');
  }

  // lstat, not existsSync: SingletonLock is a dangling symlink, so existsSync
  // (which follows) would report false even when the entry is present.
  function entryExists(p: string): boolean {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  }

  // A child that stays alive until we kill it, so isPidAlive() is true.
  function liveChild(): { pid: number; kill: () => void } {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], {
      stdio: 'ignore',
    });
    return { pid: child.pid as number, kill: () => child.kill('SIGKILL') };
  }

  it('reports no_lock and clears nothing when no SingletonLock exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comate-reap-nolock-'));
    try {
      const result = await reapStaleProfileLock(dir);
      assert.strictEqual(result.cleared, false);
      assert.strictEqual(result.reason, 'no_lock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the lock files when the holder pid is dead', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comate-reap-dead-'));
    try {
      const pid = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ['--version']);
        child.on('exit', () => resolve(child.pid as number));
      });
      writeLock(dir, pid);
      const result = await reapStaleProfileLock(dir);
      assert.strictEqual(result.cleared, true);
      assert.strictEqual(result.reason, 'dead_holder');
      assert.strictEqual(result.holderPid, pid);
      assert.strictEqual(entryExists(path.join(dir, 'SingletonLock')), false);
      assert.strictEqual(entryExists(path.join(dir, 'SingletonCookie')), false);
      assert.strictEqual(entryExists(path.join(dir, 'SingletonSocket')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a live holder whose command line is NOT bound to this profile', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comate-reap-foreign-'));
    const holder = liveChild();
    try {
      writeLock(dir, holder.pid);
      let killed = 0;
      const result = await reapStaleProfileLock(dir, {
        resolveHolderCmdline: async () => '/usr/bin/some_other_process --unrelated',
        killTree: async () => {
          killed += 1;
        },
      });
      assert.strictEqual(result.cleared, false);
      assert.strictEqual(result.reason, 'live_non_chrome_skipped');
      assert.strictEqual(result.holderPid, holder.pid);
      assert.strictEqual(killed, 0, 'must not kill an unrelated live holder');
      assert.strictEqual(
        entryExists(path.join(dir, 'SingletonLock')),
        true,
        'lock left in place for an unrelated live holder',
      );
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills and clears a live holder that is the Chrome bound to this profile', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comate-reap-orphan-'));
    const holder = liveChild();
    try {
      writeLock(dir, holder.pid);
      const killed: number[] = [];
      const result = await reapStaleProfileLock(dir, {
        resolveHolderCmdline: async () =>
          `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} about:blank`,
        killTree: async (pid) => {
          killed.push(pid);
        },
      });
      assert.strictEqual(result.cleared, true);
      assert.strictEqual(result.reason, 'orphan_chrome_killed');
      assert.strictEqual(result.holderPid, holder.pid);
      assert.deepStrictEqual(killed, [holder.pid], 'must kill the verified orphan Chrome');
      assert.strictEqual(entryExists(path.join(dir, 'SingletonLock')), false);
      assert.strictEqual(entryExists(path.join(dir, 'SingletonCookie')), false);
      assert.strictEqual(entryExists(path.join(dir, 'SingletonSocket')), false);
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
