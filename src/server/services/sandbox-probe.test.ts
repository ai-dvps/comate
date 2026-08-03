import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runSandboxProbe,
  ensureSandboxProbe,
  getSandboxProbeState,
  isSandboxDegraded,
  __setSandboxProbeForTesting,
  __resetSandboxProbeCacheForTesting,
  type ProbeRunner,
  type SandboxProbeResult,
} from './sandbox-probe.js';

const CANARY_CONTENT = 'comate-sandbox-probe-canary';

function makeCanaryDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-probe-test-'));
  fs.writeFileSync(path.join(dir, 'canary.txt'), CANARY_CONTENT);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

type RunnerScript = (command: string, args: string[]) => { code: number; stdout?: string };

function scriptedRunner(script: RunnerScript): { runner: ProbeRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProbeRunner = async (command, args) => {
    calls.push({ command, args });
    const result = script(command, args);
    return { code: result.code, stdout: result.stdout ?? '', stderr: '' };
  };
  return { runner, calls };
}

/** A healthy macOS host: control read works, denies are enforced. */
const darwinHealthy: RunnerScript = (_command, args) => {
  const profile = String(args[1] ?? '');
  if (profile.includes('deny file-read')) return { code: 1, stdout: '' };
  if (profile.includes('deny network-outbound')) return { code: 1, stdout: '' };
  return { code: 0, stdout: CANARY_CONTENT };
};

describe('runSandboxProbe', () => {
  it('passes on a healthy darwin host (negative assertions hold)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner, calls } = scriptedRunner(darwinHealthy);
      const result = await runSandboxProbe({ platform: 'darwin', runner, canaryDir: dir });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.failures, []);
      assert.strictEqual(result.platform, 'darwin');
      // control + fs deny + net deny
      assert.strictEqual(calls.length, 3);
    } finally {
      cleanup();
    }
  });

  it('fails when the filesystem deny is not enforced (darwin)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner } = scriptedRunner((_c, args) => {
        const profile = String(args[1] ?? '');
        // Denied read still returns the canary content → isolation broken.
        if (profile.includes('deny network-outbound')) return { code: 1 };
        return { code: 0, stdout: CANARY_CONTENT };
      });
      const result = await runSandboxProbe({ platform: 'darwin', runner, canaryDir: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.includes('filesystem-deny-not-enforced'));
    } finally {
      cleanup();
    }
  });

  it('fails when the network deny is not enforced (darwin)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner } = scriptedRunner((_c, args) => {
        const profile = String(args[1] ?? '');
        if (profile.includes('deny file-read')) return { code: 1 };
        // Canary host connects even with network-outbound denied → broken.
        return { code: 0, stdout: CANARY_CONTENT };
      });
      const result = await runSandboxProbe({ platform: 'darwin', runner, canaryDir: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.includes('network-deny-not-enforced'));
    } finally {
      cleanup();
    }
  });

  it('fails when the seatbelt control cannot execute (darwin)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner } = scriptedRunner(() => ({ code: 1 }));
      const result = await runSandboxProbe({ platform: 'darwin', runner, canaryDir: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.includes('seatbelt-exec-failed'));
    } finally {
      cleanup();
    }
  });

  it('passes on a healthy linux host (bubblewrap denies enforced)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner } = scriptedRunner((command, args) => {
        assert.strictEqual(command, 'bwrap');
        if (args.includes('--version')) return { code: 0, stdout: 'bubblewrap 0.9.0' };
        if (args.includes('--tmpfs')) return { code: 1 };
        if (args.includes('--unshare-net')) return { code: 1 };
        return { code: 0, stdout: CANARY_CONTENT };
      });
      const result = await runSandboxProbe({ platform: 'linux', runner, canaryDir: dir });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.failures, []);
    } finally {
      cleanup();
    }
  });

  it('fails when bubblewrap is missing (linux)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const runner: ProbeRunner = async () => ({ code: null, stdout: '', stderr: '', error: 'spawn bwrap ENOENT' });
      const result = await runSandboxProbe({ platform: 'linux', runner, canaryDir: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.includes('bubblewrap-missing'));
    } finally {
      cleanup();
    }
  });

  it('fails when the bubblewrap control cannot run (linux, e.g. AppArmor)', async () => {
    const { dir, cleanup } = makeCanaryDir();
    try {
      const { runner } = scriptedRunner((_c, args) => {
        if (args.includes('--version')) return { code: 0, stdout: 'bubblewrap 0.9.0' };
        return { code: 1, stdout: '' };
      });
      const result = await runSandboxProbe({ platform: 'linux', runner, canaryDir: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failures.includes('bubblewrap-exec-failed'));
    } finally {
      cleanup();
    }
  });

  it('fails closed on unsupported platforms (win32)', async () => {
    const runner: ProbeRunner = async () => {
      throw new Error('runner must not be called on unsupported platforms');
    };
    const result = await runSandboxProbe({ platform: 'win32', runner });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.includes('platform-unsupported'));
  });

  it('creates and cleans up its own canary dir when none is injected', async () => {
    const { runner } = scriptedRunner(darwinHealthy);
    const result = await runSandboxProbe({ platform: 'darwin', runner });
    assert.strictEqual(result.ok, true);
    const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('comate-sandbox-probe-'));
    assert.deepStrictEqual(leftovers, []);
  });
});

describe('ensureSandboxProbe state machine', { concurrency: false }, () => {
  beforeEach(() => {
    __setSandboxProbeForTesting(undefined);
    __resetSandboxProbeCacheForTesting();
  });

  afterEach(() => {
    __setSandboxProbeForTesting(undefined);
    __resetSandboxProbeCacheForTesting();
  });

  function stubResult(ok: boolean): SandboxProbeResult {
    return { ok, platform: 'darwin', failures: ok ? [] : ['filesystem-deny-not-enforced'], checkedAt: Date.now(), durationMs: 1 };
  }

  it('caches results within the TTL window', async () => {
    let calls = 0;
    __setSandboxProbeForTesting(async () => {
      calls += 1;
      return stubResult(true);
    });
    const first = await ensureSandboxProbe();
    const second = await ensureSandboxProbe();
    assert.strictEqual(calls, 1);
    assert.strictEqual(first, second);
    assert.strictEqual(getSandboxProbeState()?.ok, true);
    assert.strictEqual(isSandboxDegraded(), false);
  });

  it('forceRefresh re-runs the probe and flips degraded → available', async () => {
    let ok = false;
    __setSandboxProbeForTesting(async () => stubResult(ok));
    const degraded = await ensureSandboxProbe();
    assert.strictEqual(degraded.ok, false);
    assert.strictEqual(isSandboxDegraded(), true);

    ok = true;
    const recovered = await ensureSandboxProbe({ forceRefresh: true });
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(isSandboxDegraded(), false);
  });

  it('flips available → degraded on re-probe', async () => {
    let ok = true;
    __setSandboxProbeForTesting(async () => stubResult(ok));
    await ensureSandboxProbe();
    assert.strictEqual(isSandboxDegraded(), false);
    ok = false;
    await ensureSandboxProbe({ forceRefresh: true });
    assert.strictEqual(isSandboxDegraded(), true);
  });

  it('coalesces concurrent probes into one run', async () => {
    let calls = 0;
    __setSandboxProbeForTesting(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stubResult(true);
    });
    const [a, b] = await Promise.all([ensureSandboxProbe(), ensureSandboxProbe()]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(a, b);
  });
});
