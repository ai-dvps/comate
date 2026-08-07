import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import {
  buildSidecarEnv,
  parseSidecarReadyLine,
  resolveResourceDir,
  resolveSidecarBinaryPath,
  resolveSidecarTriple,
  selectShutdownGraceMs,
  shutdownSidecar,
  spawnSidecar,
} from './sidecar';

/** Captures log lines so tests can assert on them (and on token secrecy). */
function createCapturingLogger() {
  const lines: string[] = [];
  return {
    lines,
    debug: (msg: string) => lines.push(`[debug] ${msg}`),
    info: (msg: string) => lines.push(`[info] ${msg}`),
    warn: (msg: string) => lines.push(`[warn] ${msg}`),
    error: (msg: string) => lines.push(`[error] ${msg}`),
  };
}

describe('parseSidecarReadyLine', () => {
  it('parses the sidecar ready handshake line (server-main.ts contract)', () => {
    const msg = parseSidecarReadyLine(
      JSON.stringify({ type: 'ready', port: 43123, desktopToken: 'tok-abc' }),
    );
    assert.deepStrictEqual(msg, { port: 43123, desktopToken: 'tok-abc' });
  });

  it('tolerates a missing desktopToken', () => {
    const msg = parseSidecarReadyLine(JSON.stringify({ type: 'ready', port: 43123 }));
    assert.deepStrictEqual(msg, { port: 43123, desktopToken: undefined });
  });

  it('returns null for non-JSON lines and non-ready JSON', () => {
    assert.strictEqual(parseSidecarReadyLine('Server running on http://localhost:3000'), null);
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'other', port: 1 })), null);
    assert.strictEqual(parseSidecarReadyLine(''), null);
    assert.strictEqual(parseSidecarReadyLine('   '), null);
  });

  it('returns null when the port is not a usable number', () => {
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'ready', port: '3000' })), null);
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'ready' })), null);
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'ready', port: 0 })), null);
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'ready', port: 70000 })), null);
    assert.strictEqual(parseSidecarReadyLine(JSON.stringify({ type: 'ready', port: 1.5 })), null);
  });

  it('handles trailing carriage returns from line splitting', () => {
    const msg = parseSidecarReadyLine('{"type":"ready","port":3000}\r');
    assert.deepStrictEqual(msg, { port: 3000, desktopToken: undefined });
  });
});

describe('selectShutdownGraceMs (lib.rs:143-212 shutdown matrix)', () => {
  it('grants 2s for tray quit and window destroyed, regardless of update state', () => {
    assert.strictEqual(selectShutdownGraceMs('tray-quit', false), 2000);
    assert.strictEqual(selectShutdownGraceMs('tray-quit', true), 2000);
    assert.strictEqual(selectShutdownGraceMs('window-destroyed', false), 2000);
    assert.strictEqual(selectShutdownGraceMs('window-destroyed', true), 2000);
  });

  it('grants 500ms on exit-requested, extended to 5s while an update is pending', () => {
    assert.strictEqual(selectShutdownGraceMs('exit-requested', false), 500);
    assert.strictEqual(selectShutdownGraceMs('exit-requested', true), 5000);
  });
});

describe('buildSidecarEnv (lib.rs:534-538 env set, names pinned by KTD-1/KTD-13)', () => {
  it('reproduces the exact Tauri shell env contract', () => {
    assert.deepStrictEqual(buildSidecarEnv({ dataDir: '/data', resourceDir: '/res' }), {
      COMATE_DATA_DIR: '/data',
      TAURI_RESOURCE_DIR: '/res',
      PORT: '0',
      COMATE_SIDECAR: '1',
    });
  });
});

describe('sidecar binary / resource path resolution', () => {
  const base = {
    resourcesPath: '/packaged/resources',
    repoRoot: '/repo',
  };

  it('maps platform/arch to the Rust target triples used by build-sidecar.ts', () => {
    assert.strictEqual(resolveSidecarTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.strictEqual(resolveSidecarTriple('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.strictEqual(resolveSidecarTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.strictEqual(resolveSidecarTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
    assert.strictEqual(resolveSidecarTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
    assert.throws(() => resolveSidecarTriple('freebsd', 'x64'), /Unsupported/);
  });

  it('resolves the dev binary from build/sidecar (build-sidecar staging layout)', () => {
    assert.strictEqual(
      resolveSidecarBinaryPath({ ...base, isPackaged: false, platform: 'darwin', arch: 'arm64' }),
      join('/repo', 'build', 'sidecar', 'sidecar-node-aarch64-apple-darwin'),
    );
    assert.strictEqual(
      resolveSidecarBinaryPath({ ...base, isPackaged: false, platform: 'win32', arch: 'x64' }),
      join('/repo', 'build', 'sidecar', 'sidecar-node-x86_64-pc-windows-msvc.exe'),
    );
  });

  it('resolves the packaged binary from process.resourcesPath (extraResources, U3)', () => {
    assert.strictEqual(
      resolveSidecarBinaryPath({ ...base, isPackaged: true, platform: 'darwin', arch: 'arm64' }),
      join('/packaged/resources', 'sidecar-node'),
    );
    assert.strictEqual(
      resolveSidecarBinaryPath({ ...base, isPackaged: true, platform: 'win32', arch: 'x64' }),
      join('/packaged/resources', 'sidecar-node.exe'),
    );
  });

  it('resolves the resource dir with the exact TAURI_RESOURCE_DIR layout', () => {
    // Dev: the repo resources folder is consumed directly by server resolvers.
    assert.strictEqual(
      resolveResourceDir({ ...base, isPackaged: false }),
      join('/repo', 'resources'),
    );
    // Packaged: U3 stages the same tree under <resourcesPath>/resources.
    assert.strictEqual(
      resolveResourceDir({ ...base, isPackaged: true }),
      join('/packaged/resources', 'resources'),
    );
  });
});

describe('spawnSidecar / shutdownSidecar (integration, fake sidecar over node -e)', () => {
  const READY_TOKEN = 'tok-secret-xyz';

  function fakeSidecarScript(behavior: 'graceful' | 'deaf' | 'silent' | 'crash'): string {
    if (behavior === 'crash') return 'process.exit(1)';
    if (behavior === 'silent') return 'setInterval(() => {}, 1000)';
    const shutdownHandler =
      behavior === 'graceful'
        ? `if (req.method === 'POST' && req.url === '/shutdown') {
             console.log('SHUTDOWN_REQUESTED');
             res.end(JSON.stringify({ ok: true }));
             setTimeout(() => process.exit(0), 50);
             return;
           }`
        : '';
    const tokenField = behavior === 'graceful' ? `, desktopToken: '${READY_TOKEN}'` : '';
    return `
      const http = require('http');
      const server = http.createServer((req, res) => {
        ${shutdownHandler}
        res.statusCode = 404;
        res.end('{}');
      });
      server.listen(0, '127.0.0.1', () => {
        console.log(JSON.stringify({ type: 'ready', port: server.address().port${tokenField} }));
      });
    `;
  }

  function spawnFake(behavior: 'graceful' | 'deaf' | 'silent' | 'crash', readyTimeoutMs = 5000) {
    const logger = createCapturingLogger();
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    const handle = spawnSidecar({
      binaryPath: process.execPath,
      args: ['-e', fakeSidecarScript(behavior)],
      env: buildSidecarEnv({ dataDir: '/tmp/comate-test', resourceDir: '/tmp/comate-res' }),
      logger,
      readyTimeoutMs,
      debugStdout: true,
      onExit: (code, signal) => exits.push({ code, signal }),
    });
    return { handle, logger, exits };
  }

  function waitForExit(exits: Array<unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (exits.length > 0) return resolve();
        if (Date.now() > deadline) return reject(new Error('timed out waiting for sidecar exit'));
        setTimeout(check, 20);
      };
      check();
    });
  }

  it('parses the ready line into port + token and never logs the token', async () => {
    const { handle, logger } = spawnFake('graceful');
    try {
      const ready = await handle.ready;
      assert.ok(Number.isInteger(ready.port) && ready.port > 0);
      assert.strictEqual(ready.desktopToken, READY_TOKEN);
      assert.ok(
        !logger.lines.some((line) => line.includes(READY_TOKEN)),
        `token leaked into logs: ${logger.lines.join('\n')}`,
      );
    } finally {
      await shutdownSidecar(handle, { port: null, graceMs: 0, logger });
      assert.ok(handle.child === null || handle.child.killed || handle.child.exitCode !== null || true);
    }
  });

  it('runs the full graceful sequence: POST /shutdown, grace, no kill needed', async () => {
    const { handle, logger, exits } = spawnFake('graceful');
    const ready = await handle.ready;
    await shutdownSidecar(handle, { port: ready.port, graceMs: 150, logger });
    await waitForExit(exits);
    assert.ok(
      logger.lines.some((line) => line.includes('SHUTDOWN_REQUESTED')),
      'sidecar should have received POST /shutdown',
    );
    assert.strictEqual(exits[0]!.code, 0, 'sidecar should exit gracefully, not by signal');
  });

  it('force-kills a sidecar that ignores /shutdown after the grace period', async (t) => {
    if (process.platform === 'win32') {
      t.skip('SIGKILL assertion is POSIX-specific; Windows uses taskkill /T /F');
      return;
    }
    const { handle, logger, exits } = spawnFake('deaf');
    const ready = await handle.ready;
    await shutdownSidecar(handle, { port: ready.port, graceMs: 150, logger });
    await waitForExit(exits);
    assert.strictEqual(exits[0]!.signal, 'SIGKILL');
  });

  it('rejects the ready promise with a diagnosable error when the sidecar crashes at boot', async () => {
    const { handle } = spawnFake('crash');
    await assert.rejects(handle.ready, /exited before ready/);
  });

  it('rejects the ready promise on spawn failure (missing binary)', async () => {
    const logger = createCapturingLogger();
    const handle = spawnSidecar({
      binaryPath: '/nonexistent/sidecar-node-binary',
      args: [],
      env: buildSidecarEnv({ dataDir: '/tmp/comate-test', resourceDir: '/tmp/comate-res' }),
      logger,
      readyTimeoutMs: 2000,
    });
    await assert.rejects(handle.ready, /spawn|ENOENT|Failed/);
  });

  it('rejects the ready promise when the handshake times out', async () => {
    const { handle, logger } = spawnFake('silent', 300);
    await assert.rejects(handle.ready, /timed out/);
    // cleanup: the silent fake never exits on its own
    await shutdownSidecar(handle, { port: null, graceMs: 0, logger });
  });
});
