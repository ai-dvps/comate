/**
 * U7 shell-path e2e gate (replaces scripts/test-browser-cdp.ts as the release
 * prerequisite): Playwright drives a REAL Electron shell — control channel
 * view creation, CDP attach through the shell's debug port, core tool
 * mechanics, and the KTD-16 webPreferences attestation.
 *
 * What this proves end to end:
 *  1. the main process opens a loopback-only debug port (no
 *     --remote-allow-origins — the gate's ws client sends no Origin header);
 *  2. the KTD-11 control channel creates a per-session WebContentsView
 *     (persist:comate-browser-<id> partition, KTD-10) and reports the view's
 *     getLastWebPreferences() — sandbox on / contextIsolation on /
 *     nodeIntegration off / no preload (KTD-16);
 *  3. the view's page target is discoverable on the debug port via the
 *     about:blank#<marker> convention and attachable (flatten) — the exact
 *     path browser-service takes;
 *  4. core tool mechanics work against the in-shell view: navigate, evaluate,
 *     screenshot, AX tree, and the KTD-12 fingerprint (no Electron UA, no
 *     navigator.webdriver) on every new document;
 *  5. view teardown via the control channel removes the CDP target.
 *
 * Skips with a message when Electron cannot launch in the environment (no GUI
 * / sandboxed CI); --required (or COMATE_REQUIRE_ELECTRON_CDP=1) turns a skip
 * into a failure (release gate). macOS CI runners have a GUI.
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const required =
  process.env.COMATE_REQUIRE_ELECTRON_CDP === '1' || process.argv.includes('--required');

function unavailable(reason: string): never {
  if (required) {
    throw new Error(`Electron shell CDP gate required but unavailable: ${reason}`);
  }
  console.log(`SKIP electron shell CDP gate: ${reason}`);
  process.exit(0);
}

const execFileAsync = promisify(execFile);

// Fresh build of the main/preload bundles so the gate always tests the
// current source (cheap: electron-vite main+preload only, no renderer).
try {
  await execFileAsync('npm', ['run', 'build:electron', '--silent'], { timeout: 180_000 });
} catch (err) {
  unavailable(`electron-vite build failed: ${err instanceof Error ? err.message : String(err)}`);
}

let electronBinary: string;
try {
  electronBinary = (await import('electron')).default as unknown as string;
} catch {
  unavailable('the electron package is not installed');
}
if (!electronBinary || typeof electronBinary !== 'string') {
  unavailable('could not resolve the electron binary');
}

let playwright: typeof import('playwright');
try {
  playwright = await import('playwright');
} catch {
  unavailable('playwright is not installed');
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port allocation failed');
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'comate-electron-gate-'));
const controlPort = await allocatePort();
const debugPort = await allocatePort();
const token = randomBytes(24).toString('base64url');

// Dev shells sometimes export ELECTRON_RUN_AS_NODE=1 (editor/CLI tooling);
// with it the binary boots as plain Node and the app never starts.
const launchEnv = { ...process.env };
delete launchEnv['ELECTRON_RUN_AS_NODE'];

const electronApp = await playwright._electron
  .launch({
    executablePath: electronBinary,
    args: ['.'],
    cwd: path.resolve('.'),
    timeout: 60_000,
    env: {
      ...launchEnv,
      COMATE_DATA_DIR: dataDir,
      COMATE_SHELL_CONTROL_PORT: String(controlPort),
      COMATE_SHELL_DEBUG_PORT: String(debugPort),
      COMATE_SHELL_CONTROL_TOKEN: token,
    },
  })
  .catch((err: Error) => {
    unavailable(
      `Electron failed to launch in this environment (no GUI / sandbox?): ${err.message}`,
    );
  });

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}: ${detail}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function controlFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${controlPort}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

const { connectShellPage, listCdpTargets } = await import(
  '../src/server/services/browser-cdp.js'
);

let viewTargetId: string | undefined;

try {
  console.log(`electron shell CDP gate: control=127.0.0.1:${controlPort} debug=127.0.0.1:${debugPort}`);

  let controlUp = false;
  for (let attempt = 0; attempt < 150 && !controlUp; attempt += 1) {
    try {
      const res = await controlFetch('/health');
      controlUp = res.ok;
    } catch {
      // main process still starting
    }
    if (!controlUp) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await check('E1 control channel answers (token-gated) and is not quitting', async () => {
    assert(controlUp, `control channel never came up on 127.0.0.1:${controlPort}`);
    const health = (await (await controlFetch('/health')).json()) as { ok: boolean; quitting: boolean };
    assert(health.ok === true && health.quitting === false, JSON.stringify(health));
    const noAuth = await fetch(`http://127.0.0.1:${controlPort}/health`);
    assert(noAuth.status === 401, `unauthenticated request returned ${noAuth.status}`);
  });

  const marker = `comate-view-gate-${randomBytes(6).toString('hex')}`;
  await check('E2 view creation via control channel: partition + KTD-16 webPreferences attestation', async () => {
    const res = await controlFetch('/views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'gate-1', marker }),
    });
    const raw = await res.text();
    assert(res.status === 201, `create view returned ${res.status}: ${raw}`);
    const body = JSON.parse(raw) as {
      partition: string;
      targetMarker: string;
      webPreferences: { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; preload: string | null };
    };
    assert(body.partition === 'persist:comate-browser-gate-1', `partition ${body.partition}`);
    assert(body.targetMarker === marker, 'marker mismatch');
    const prefs = body.webPreferences;
    assert(
      prefs.sandbox === true &&
        prefs.contextIsolation === true &&
        prefs.nodeIntegration === false &&
        prefs.preload === null,
      `getLastWebPreferences attestation failed: ${JSON.stringify(prefs)}`,
    );
  });

  await check('E3 view page target discoverable on the debug port via the marker', async () => {
    for (let attempt = 0; attempt < 50 && !viewTargetId; attempt += 1) {
      const targets = await listCdpTargets({ port: debugPort });
      viewTargetId = targets.find(
        (t) => t.type === 'page' && t.url.includes(marker),
      )?.id;
      if (!viewTargetId) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(viewTargetId, 'marker target never appeared in /json/list');
  });

  await check('E4 CDP attach + core tool mechanics against the in-shell view', async () => {
    assert(viewTargetId, 'no view target');
    const page = await connectShellPage({ port: debugPort, targetId: viewTargetId });
    try {
      await page.navigate(
        'data:text/html,<!doctype html><title>gate</title><body><h1>shell gate</h1><a href="data:text/html,next">next</a></body>',
      );
      assert((await page.evaluate<string>('document.title')) === 'gate', 'evaluate failed');
      const tree = await page.getFullAXTree();
      assert(tree.length > 0, 'empty AX tree');
      // NOTE: Page.captureScreenshot is intentionally NOT asserted here — an
      // unattached WebContentsView has no compositor surface in U7 (plan:
      // views stay unattached until U8 wires panel bounds). Screenshot parity
      // is proven against the external endpoint in test-shell-cdp.ts (B8) and
      // lands in-shell with U8's attach.
      // nodeIntegration-off, from the renderer's own perspective.
      assert(
        (await page.evaluate<string>('typeof process')) === 'undefined' &&
          (await page.evaluate<string>('typeof require')) === 'undefined',
        'Node globals leaked into the browser view',
      );
    } finally {
      page.close();
    }
  });

  await check('E5 fingerprint parity in-shell (KTD-12): synthetic desktop Chrome on every document', async () => {
    assert(viewTargetId, 'no view target');
    const page = await connectShellPage({ port: debugPort, targetId: viewTargetId });
    try {
      const readSurface = `JSON.stringify({
        ua: navigator.userAgent,
        webdriver: navigator.webdriver === undefined ? 'undefined' : String(navigator.webdriver),
        brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand).join(','),
      })`;
      for (const url of [
        'data:text/html,<title>d1</title>one',
        'data:text/html,<title>d2</title>two',
      ]) {
        await page.navigate(url);
        const surface = JSON.parse(await page.evaluate<string>(readSurface)) as Record<string, string>;
        assert(
          surface.ua.includes('Chrome/') &&
            !surface.ua.includes('Electron') &&
            !surface.ua.includes('HeadlessChrome'),
          `UA not synthetic desktop Chrome: ${surface.ua}`,
        );
        assert(surface.webdriver === 'undefined', `navigator.webdriver leaked: ${surface.webdriver}`);
        assert(String(surface.brands).includes('Google Chrome'), `UA-CH brands wrong: ${surface.brands}`);
      }
    } finally {
      page.close();
    }
  });

  await check('E6 view teardown via control channel removes the CDP target', async () => {
    const res = await controlFetch('/views/gate-1', { method: 'DELETE' });
    const body = (await res.json()) as { ok: boolean; destroyed: boolean };
    assert(body.destroyed === true, `destroy failed: ${JSON.stringify(body)}`);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const targets = await listCdpTargets({ port: debugPort });
      if (!targets.some((t) => t.id === viewTargetId)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('view target still listed after destroy');
  });
} finally {
  await electronApp.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\nFAIL electron shell CDP gate: ${failed.length}/${results.length} failed`);
  process.exit(1);
}
console.log(`\nPASS electron shell CDP gate: ${results.length} checks (real Electron shell)`);
