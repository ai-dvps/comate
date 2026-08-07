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
 *     AX tree, and the KTD-12 fingerprint (no Electron UA, no
 *     navigator.webdriver) on every new document;
 *  5. view teardown via the control channel removes the CDP target;
 *  6. U8 panel wiring: a rect report attaches the view to the window and
 *     applies bounds (following resize), the attached view produces real
 *     Page.captureScreenshot output, window.open becomes a managed
 *     same-partition overlay view (never an OS window), open/close cycles
 *     return the page-target count to baseline (render-process leak soak),
 *     and orphan partitions are reconciled against the sidecar's keep list.
 *
 * Skips with a message when Electron cannot launch in the environment (no GUI
 * / sandboxed CI); --required (or COMATE_REQUIRE_ELECTRON_CDP=1) turns a skip
 * into a failure (release gate). macOS CI runners have a GUI.
 */

import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
// U8: pre-seed an orphan partition dir (a "previous boot" leftover) so the
// reconciliation check can watch it being swept.
const orphanPartitionDir = path.join(dataDir, 'shell', 'Partitions', 'comate-browser-orphan-e2e');
mkdirSync(orphanPartitionDir, { recursive: true });
writeFileSync(path.join(orphanPartitionDir, 'leftover'), 'x');
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
      // NOTE: Page.captureScreenshot is asserted on an ATTACHED view in E8 —
      // this first view is still unattached (no panel rect reported yet).
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

  // ------------------------------------------------------------------
  // U8: native panel wiring — attach/bounds, screenshot on the attached
  // view, managed popup overlays, open/close leak soak, orphan reconcile.
  // ------------------------------------------------------------------

  // Popup target for E9: the managed-overlay path only accepts http(s).
  const popupServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${req.url === '/b' ? 'popup-b' : 'popup-a'}</title><body>${req.url}</body>`);
  });
  await new Promise<void>((resolve) => popupServer.listen(0, '127.0.0.1', () => resolve()));
  const popupAddress = popupServer.address();
  const popupPort = popupAddress && typeof popupAddress === 'object' ? popupAddress.port : 0;

  const marker2 = `comate-view-gate2-${randomBytes(6).toString('hex')}`;
  let gate2TargetId: string | undefined;
  const GATE2_RECT = { x: 64, y: 48, width: 640, height: 480 };

  await check('E7 rect report attaches the view to the window and applies bounds', async () => {
    const create = await controlFetch('/views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'gate-2', marker: marker2 }),
    });
    assert(create.status === 201, `create gate-2 returned ${create.status}`);
    // Before any rect: unattached (the panel is not showing).
    const before = (await (await controlFetch('/views/gate-2')).json()) as {
      state: { attached: boolean; visible: boolean };
    };
    assert(before.state.attached === false && before.state.visible === false, JSON.stringify(before));
    const bounds = await controlFetch('/views/gate-2/bounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(GATE2_RECT),
    });
    assert(bounds.ok, `bounds report returned ${bounds.status}`);
    const after = (await (await controlFetch('/views/gate-2')).json()) as {
      state: { attached: boolean; visible: boolean; bounds: typeof GATE2_RECT; inputMode: string; pointerGated: boolean };
    };
    assert(after.state.attached === true, `not attached: ${JSON.stringify(after.state)}`);
    assert(after.state.visible === true, 'not visible after rect report');
    assert(
      after.state.bounds && after.state.bounds.width === GATE2_RECT.width && after.state.bounds.x === GATE2_RECT.x,
      `bounds not applied: ${JSON.stringify(after.state.bounds)}`,
    );
    // Safe default gating until the panel reports user_in_control.
    assert(after.state.inputMode === 'agent' && after.state.pointerGated === true, 'default gating wrong');
    // Bounds follow a resize.
    await controlFetch('/views/gate-2/bounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...GATE2_RECT, width: 700 }),
    });
    const resized = (await (await controlFetch('/views/gate-2')).json()) as {
      state: { bounds: { width: number } };
    };
    assert(resized.state.bounds.width === 700, 'bounds did not follow resize');
    for (let attempt = 0; attempt < 50 && !gate2TargetId; attempt += 1) {
      const targets = await listCdpTargets({ port: debugPort });
      gate2TargetId = targets.find((t) => t.type === 'page' && t.url.includes(marker2))?.id;
      if (!gate2TargetId) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(gate2TargetId, 'gate-2 target never appeared in /json/list');
  });

  await check('E8 Page.captureScreenshot works on the attached view (U7 leftover fix)', async () => {
    assert(gate2TargetId, 'no gate-2 target');
    const page = await connectShellPage({ port: debugPort, targetId: gate2TargetId });
    try {
      await page.navigate('data:text/html,<title>shot</title><body style="background:#123">pixels</body>');
      const shot = await page.captureScreenshot();
      assert(typeof shot === 'string' && shot.length > 500, `screenshot too small: ${shot.length}`);
    } finally {
      page.close();
    }
  });

  await check('E9 window.open becomes a managed same-partition overlay (OAuth decision)', async () => {
    assert(gate2TargetId, 'no gate-2 target');
    const page = await connectShellPage({ port: debugPort, targetId: gate2TargetId });
    let popupTargetId: string | undefined;
    try {
      await page.navigate(`http://127.0.0.1:${popupPort}/a`);
      const opened = await page.evaluate<string>(
        `(() => { window.open('http://127.0.0.1:${popupPort}/b'); return 'opened'; })()`,
      );
      assert(opened === 'opened', 'window.open evaluate failed');
      for (let attempt = 0; attempt < 50 && !popupTargetId; attempt += 1) {
        const targets = await listCdpTargets({ port: debugPort });
        popupTargetId = targets.find(
          (t) => t.type === 'page' && t.url.includes(`127.0.0.1:${popupPort}/b`),
        )?.id;
        if (!popupTargetId) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(popupTargetId, 'popup target never appeared on the debug port (no OS window allowed)');
      const state = (await (await controlFetch('/views/gate-2')).json()) as {
        state: { popupCount: number };
      };
      assert(state.state.popupCount === 1, `expected one managed popup: ${JSON.stringify(state.state)}`);
      // OAuth-style self-close: the popup page's window.close() must reap the
      // overlay view (no orphan windows over the panel).
      const popupPage = await connectShellPage({ port: debugPort, targetId: popupTargetId });
      try {
        await popupPage.evaluate<string>('(() => { window.close(); return "closing"; })()');
      } finally {
        popupPage.close();
      }
      let popupGone = false;
      for (let attempt = 0; attempt < 25 && !popupGone; attempt += 1) {
        const s = (await (await controlFetch('/views/gate-2')).json()) as {
          state: { popupCount: number };
        };
        popupGone = s.state.popupCount === 0;
        if (!popupGone) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(popupGone, 'popup overlay did not self-close on window.close()');
      popupTargetId = undefined; // already reaped — skip the teardown watch below
    } finally {
      page.close();
    }
    // Destroying the parent takes the overlay down with it.
    const del = await controlFetch('/views/gate-2', { method: 'DELETE' });
    assert((await del.json()).destroyed === true, 'gate-2 destroy failed');
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const targets = await listCdpTargets({ port: debugPort });
      if (!targets.some((t) => t.id === popupTargetId) && !targets.some((t) => t.id === gate2TargetId)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('popup/parent target still listed after parent destroy');
  });

  await check('E10 open/close cycles return the render-process count to baseline (leak soak)', async () => {
    const baseline = (await listCdpTargets({ port: debugPort })).filter((t) => t.type === 'page').length;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const sessionId = `soak-${cycle}`;
      const create = await controlFetch('/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, marker: `comate-view-${sessionId}` }),
      });
      assert(create.status === 201, `soak create ${cycle} returned ${create.status}`);
      await controlFetch(`/views/${sessionId}/bounds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(GATE2_RECT),
      });
      const del = await controlFetch(`/views/${sessionId}`, { method: 'DELETE' });
      assert((await del.json()).destroyed === true, `soak destroy ${cycle} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = (await listCdpTargets({ port: debugPort })).filter((t) => t.type === 'page').length;
    assert(after === baseline, `page target count drifted: baseline=${baseline} after=${after}`);
  });

  await check('E11 orphan partition reconciliation sweeps unlisted partitions (KTD-11)', async () => {
    assert(existsSync(orphanPartitionDir), 'pre-seeded orphan partition missing before reconcile');
    const res = await controlFetch('/partitions/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: [] }),
    });
    const body = (await res.json()) as { ok: boolean; removed: string[]; errors: string[] };
    assert(body.ok === true, `reconcile failed: ${JSON.stringify(body)}`);
    assert(
      body.removed.includes('orphan-e2e'),
      `orphan partition not swept: ${JSON.stringify(body)}`,
    );
    assert(!existsSync(orphanPartitionDir), 'orphan partition dir still on disk');
  });

  popupServer.close();
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
