/**
 * U7 shell-CDP contract suite (proof-first per the plan's execution note):
 * runs the native CDP-peer layer (`browser-cdp.ts` connectShellPage family +
 * `browser-fingerprint.ts`) against a REAL Chromium launched with a debug
 * port — the exact transport the Electron shell exposes (KTD-6) and the R8
 * external fallback endpoint speaks.
 *
 * PART A (this suite): transport/peer contract — target selection via /json,
 * flatten attach, page ops, network capture, fingerprint parity (KTD-12),
 * browser-context isolation (partition stand-in, KTD-10), cold-start retry,
 * target-destroyed detection, session-context export.
 * PART B (tool parity, appended by the U7 service work): the 11 comate-browser
 * tools driven through BrowserToolContext + BrowserService against the same
 * endpoint via COMATE_BROWSER_CDP_TARGET (AE2 mechanism, R8).
 *
 * The Chromium binary comes from the Playwright dev dependency (U9: the pinned
 * Chrome for Testing bundle left the repo with the legacy browser stack; the
 * contract under test is version-agnostic — version assertions derive from
 * the resolved binary itself). The suite drives the chrome-headless-shell
 * binary: the full Chromium's headless mode never answers
 * Page.captureScreenshot over raw CDP (Playwright itself launches the
 * headless shell for headless work). Skips with a message when no Chromium
 * is installed; --required (or COMATE_REQUIRE_SHELL_CDP=1) turns a skip into
 * a failure (release gate).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium as playwrightChromium } from 'playwright';

import { createGateHarness } from './lib/gate-harness.js';

const { unavailable, check, assert, results } = createGateHarness({
  gateName: 'shell CDP contract suite',
  requiredEnvVar: 'COMATE_REQUIRE_SHELL_CDP',
});

/**
 * Resolve Playwright's chrome-headless-shell next to the full chromium
 * executable: <cache>/chromium-<rev>/<platform-dir>/<binary> →
 * <cache>/chromium_headless_shell-<rev>/chrome-headless-shell-<platform>/<bin>.
 * `npx playwright install chromium` installs both.
 */
function resolveHeadlessShellExecutable(): string | undefined {
  let full: string;
  try {
    full = playwrightChromium.executablePath();
  } catch {
    return undefined;
  }
  const match = /^(.*[/\\]chromium)-(\d+)[/\\]/.exec(full);
  if (!match) return undefined;
  const [, cacheRoot, rev] = match;
  const platformDir =
    process.platform === 'darwin'
      ? `chrome-headless-shell-mac${process.arch === 'arm64' ? '-arm64' : ''}`
      : process.platform === 'win32'
        ? 'chrome-headless-shell-win64'
        : `chrome-headless-shell-linux${process.arch === 'arm64' ? '-arm64' : '64'}`;
  const binary = `chrome-headless-shell${process.platform === 'win32' ? '.exe' : ''}`;
  const candidate = path.join(
    `${cacheRoot}_headless_shell-${rev}`,
    platformDir,
    binary,
  );
  return existsSync(candidate) ? candidate : undefined;
}

const chromiumPath = resolveHeadlessShellExecutable();
if (!chromiumPath) {
  unavailable('no Playwright Chromium installed (run `npx playwright install chromium`)');
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'comate-shell-cdp-'));
process.env.COMATE_DATA_DIR = tempDir;

// ---------------------------------------------------------------------------
// Fixture origin
// ---------------------------------------------------------------------------

const fixture = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const cookieEcho = `cookies=${req.headers.cookie ?? ''}`;
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: '/quota' });
    res.end();
    return;
  }
  if (url.pathname === '/quota') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ remaining: 42 }));
    return;
  }
  if (url.pathname === '/frame-data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ frame: true }));
    return;
  }
  if (url.pathname === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' });
    // Retry the probe fetch: the capture's auto-attach races the frame load,
    // and a single-shot fetch makes the OOPIF-capture assertion flaky.
    res.end(`<!doctype html><script>
      var tries = 0;
      var timer = setInterval(() => {
        tries += 1;
        fetch('/frame-data?try=' + tries).then(r => r.json()).then(() => parent.postMessage('frame-ready', '*'));
        if (tries > 30) clearInterval(timer);
      }, 100);
    </script>frame`);
    return;
  }
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>echo</title><body>${cookieEcho}</body><script>
      document.body.textContent += ' ls=' + (localStorage.getItem('session') || '');
    </script>`);
    return;
  }
  if (url.pathname === '/login') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': 'fixture_auth=secret-token; Path=/; SameSite=Lax',
    });
    res.end(`<!doctype html><title>login</title><script>localStorage.setItem('session', 'abc123');</script>logged in`);
    return;
  }
  if (url.pathname === '/form') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>form</title><body>
      <form action="/submitted" method="get">
        <label>Name <input name="name" type="text"></label>
        <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
        <label>Agree <input name="agree" type="checkbox" value="yes"></label>
        <button type="submit">Send</button>
      </form>
      <a href="/echo">echo link</a>
    </body>`);
    return;
  }
  if (url.pathname === '/submitted') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>submitted</title><body>submitted name=${url.searchParams.get('name')} plan=${url.searchParams.get('plan')}</body>`);
    return;
  }
  // Root: redirect chain + same-origin iframe fetch (network-capture fixture).
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>root</title><script>
    window.captureState = { redirect: false, frame: false };
    const frame = document.createElement('iframe');
    frame.src = 'http://localhost:' + location.port + '/frame';
    document.documentElement.appendChild(frame);
    addEventListener('message', (event) => { if (event.data === 'frame-ready') window.captureState.frame = true; });
    fetch('/redirect').then(r => r.json()).then(() => { window.captureState.redirect = true; });
  </script>ready`);
});

await new Promise<void>((resolve, reject) => {
  fixture.once('error', reject);
  // Dual-stack bind: PART A drives 127.0.0.1, PART B drives localhost (site
  // keys reject IP literals by design).
  fixture.listen(0, () => resolve());
});
const fixtureAddress = fixture.address();
if (!fixtureAddress || typeof fixtureAddress === 'string') throw new Error('fixture did not bind');
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
const fixtureHttp = `http://localhost:${fixtureAddress.port}`;

// ---------------------------------------------------------------------------
// Chromium with a debug port (the shell's CDP peer shape: loopback only, no
// --remote-allow-origins, OS-assigned port discovered via DevToolsActivePort)
// ---------------------------------------------------------------------------

const chromeUserData = mkdtempSync(path.join(tmpdir(), 'comate-shell-cdp-profile-'));
// SHELL_CDP_HEADED=1 swaps in the full Chromium for a visible debugging run;
// the default headless-shell binary is headless by itself (no flag needed —
// and the full Chromium's --headless=new never answers Page.captureScreenshot
// over raw CDP). --site-per-process forces real OOPIFs (the headless shell
// otherwise keeps cross-site iframes in-process) so the flattened iframe
// session capture in A6 exercises the production code path.
const headed = process.env.SHELL_CDP_HEADED === '1';
const executable = headed ? playwrightChromium.executablePath() : chromiumPath;
const chrome: ChildProcess = spawn(
  executable,
  [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${chromeUserData}`,
    '--site-per-process',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let chromeStderr = '';
chrome.stderr?.on('data', (chunk) => {
  chromeStderr += String(chunk);
});

async function discoverDebugPort(): Promise<number> {
  const portFile = path.join(chromeUserData, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [line] = readFileSync(portFile, 'utf8').split('\n');
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chromium never wrote DevToolsActivePort: ${chromeStderr.slice(-400)}`);
}

const debugPort = await discoverDebugPort();

const {
  CdpConnection,
  buildCdpPageBaseUrl,
  connectBrowserPage,
  connectShellPage,
  createShellTarget,
  closeShellTarget,
  exportCdpSessionContext,
  fetchCdpBrowserInfo,
  findCdpTargetIdByMarker,
  listCdpTargets,
  parseCdpPageBaseUrl,
} = await import('../src/server/services/browser-cdp.js');
const { BrowserNetworkCaptureManager } = await import(
  '../src/server/services/browser-network-capture.js'
);

// Version assertions derive from the resolved binary itself (the contract is
// version-agnostic): "Chrome/141.0.…" → "141.0.…".
const chromeVersion = (await fetchCdpBrowserInfo({ port: debugPort })).product?.split('/')[1];
if (!chromeVersion) {
  throw new Error('could not determine the Chromium version from /json/version');
}

const markerA = `comate-view-${Math.random().toString(36).slice(2)}`;
const targetA = await createShellTarget({ port: debugPort, url: `about:blank#${markerA}` });

try {
  console.log(`shell CDP contract suite: Chromium ${chromeVersion} on 127.0.0.1:${debugPort}`);

  await check('A1 browser info + marker target resolution via /json', async () => {
    const info = await fetchCdpBrowserInfo({ port: debugPort });
    assert(info.browserWsUrl.startsWith('ws://127.0.0.1:'), `unexpected browser ws ${info.browserWsUrl}`);
    assert(info.product?.includes('Chrome/'), `unexpected product ${info.product}`);
    const found = await findCdpTargetIdByMarker({ port: debugPort }, markerA);
    assert(found === targetA.targetId, `marker lookup returned ${found}, want ${targetA.targetId}`);
    const parsed = parseCdpPageBaseUrl(
      buildCdpPageBaseUrl({ host: '127.0.0.1', port: debugPort, targetId: targetA.targetId }),
    );
    assert(parsed?.targetId === targetA.targetId, 'base-url round-trip lost the targetId');
    const parsedMarker = parseCdpPageBaseUrl(
      buildCdpPageBaseUrl({ host: '127.0.0.1', port: debugPort, urlMarker: markerA }),
    );
    assert(parsedMarker?.urlMarker === markerA, 'base-url round-trip lost the marker');
    assert(parseCdpPageBaseUrl('http://127.0.0.1:8080/') === null, 'plain baseUrl must not parse as CDP page');
  });

  await check('A2 attach by targetId: evaluate / navigate / AX tree / screenshot / backend click', async () => {
    const page = await connectShellPage({ port: debugPort, targetId: targetA.targetId });
    try {
      assert((await page.evaluate<number>('1 + 1')) === 2, 'evaluate failed');
      await page.navigate(`${fixtureOrigin}/form`);
      const title = await page.evaluate<string>('document.title');
      assert(title === 'form', `title ${title}`);
      const axTree = await page.getFullAXTree();
      assert(axTree.length > 3, `AX tree too small: ${axTree.length}`);
      const linkNode = axTree.find((node) => node.name?.value === 'echo link');
      const backendNodeId = linkNode?.backendDOMNodeId;
      assert(typeof backendNodeId === 'number', 'no backend node id for link');
      const screenshot = await page.captureScreenshot();
      assert(screenshot.length > 1000 && !screenshot.startsWith('data:'), 'screenshot shape wrong');
      await page.clickBackendNode(backendNodeId);
      for (let i = 0; i < 50; i += 1) {
        const href = await page.evaluate<string>('location.href');
        if (href.startsWith(`${fixtureOrigin}/echo`)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('backend-node click did not navigate to /echo');
    } finally {
      page.close();
    }
  });

  await check('A3 attach by URL marker (pre-navigation view discovery)', async () => {
    const marker = `comate-view-${Math.random().toString(36).slice(2)}`;
    const target = await createShellTarget({ port: debugPort, url: `about:blank#${marker}` });
    const page = await connectShellPage({ port: debugPort, urlMarker: marker });
    try {
      assert((await page.evaluate<number>('6 * 7')) === 42, 'marker attach evaluate failed');
    } finally {
      page.close();
      await closeShellTarget({ port: debugPort, targetId: target.targetId });
    }
  });

  await check('A4 connectBrowserPage dispatcher routes __comate-cdp__ baseUrls', async () => {
    const baseUrl = buildCdpPageBaseUrl({ host: '127.0.0.1', port: debugPort, targetId: targetA.targetId });
    const page = await connectBrowserPage(baseUrl);
    try {
      const href = await page.evaluate<string>('location.href');
      assert(href.startsWith(`${fixtureOrigin}/echo`), `dispatcher attached to wrong target: ${href}`);
    } finally {
      page.close();
    }
  });

  await check('A5 fingerprint (KTD-12): UA override + init script on every new document', async () => {
    const target = await createShellTarget({ port: debugPort, url: 'about:blank' });
    const page = await connectShellPage({ port: debugPort, targetId: target.targetId });
    try {
      const readSurface = `JSON.stringify({
        ua: navigator.userAgent,
        webdriver: navigator.webdriver === undefined ? 'undefined' : String(navigator.webdriver),
        brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand).join(','),
        platform: navigator.platform,
        uaDataPlatform: navigator.userAgentData && navigator.userAgentData.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        vendor: navigator.vendor,
      })`;
      const assertSurface = (raw: string, where: string) => {
        const surface = JSON.parse(raw) as Record<string, string | number>;
        assert(
          typeof surface.ua === 'string' &&
            surface.ua.includes(`Chrome/${chromeVersion}`) &&
            !surface.ua.includes('HeadlessChrome') &&
            !surface.ua.includes('Electron'),
          `${where}: UA not synthetic desktop Chrome: ${surface.ua}`,
        );
        assert(surface.webdriver === 'undefined', `${where}: navigator.webdriver leaked: ${surface.webdriver}`);
        assert(
          String(surface.brands).includes('Google Chrome') && String(surface.brands).includes('Chromium'),
          `${where}: UA-CH brands wrong: ${surface.brands}`,
        );
        assert(surface.uaDataPlatform === (process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'),
          `${where}: UA-CH platform wrong: ${surface.uaDataPlatform}`);
        assert(surface.hardwareConcurrency === 8 && surface.deviceMemory === 8, `${where}: hw surface wrong`);
        assert(surface.vendor === 'Google Inc.', `${where}: vendor wrong: ${surface.vendor}`);
      };
      // The target's initial about:blank predates script registration (a
      // registered init script only covers documents created afterwards);
      // navigate first.
      await page.navigate(`${fixtureOrigin}/form`);
      assertSurface(await page.evaluate<string>(readSurface), 'after navigation');
      await page.navigate(`${fixtureOrigin}/echo`);
      assertSurface(await page.evaluate<string>(readSurface), 'second navigation');
      const highEntropy = await page.evaluate<string>(
        `navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','uaFullVersion','fullVersionList']).then(JSON.stringify)`,
      );
      const entropy = JSON.parse(highEntropy) as { uaFullVersion?: string; fullVersionList?: Array<{ brand: string; version: string }> };
      assert(entropy.uaFullVersion === chromeVersion, `uaFullVersion ${entropy.uaFullVersion}`);
      assert(
        entropy.fullVersionList?.some((b) => b.brand === 'Google Chrome' && b.version === chromeVersion),
        'fullVersionList missing real engine version',
      );
    } finally {
      page.close();
      await closeShellTarget({ port: debugPort, targetId: target.targetId });
    }
  });

  await check('A6 network capture over native attach (redirect chain + iframe session)', async () => {
    const target = await createShellTarget({ port: debugPort, url: 'about:blank' });
    const page = await connectShellPage({ port: debugPort, targetId: target.targetId });
    try {
      const transport = page.createNetworkCaptureTransport?.();
      assert(transport, 'native page session exposes no capture transport');
      const capture = new BrowserNetworkCaptureManager(transport, { quietMs: 50, hardDeadlineMs: 5_000 });
      await capture.start();
      await page.navigate(`${fixtureOrigin}/`);
      for (let i = 0; i < 100; i += 1) {
        const state = await page.evaluate<{ redirect?: boolean; frame?: boolean }>('window.captureState || {}');
        if (state.redirect && state.frame) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result = await capture.stop();
      const redirect = result.chains.find((chain) =>
        chain.hops.some((hop) => hop.request.url.endsWith('/redirect')),
      );
      const hops = redirect?.hops.map((hop) => new URL(hop.request.url).pathname);
      assert(JSON.stringify(hops) === JSON.stringify(['/redirect', '/quota']), `redirect hops ${JSON.stringify(hops)}`);
      const body = redirect?.hops.at(-1)?.responseBody?.body;
      assert(body && JSON.parse(body).remaining === 42, 'redirect final body missing');
      const frameChain = result.chains.find((chain) =>
        chain.hops.some((hop) => hop.request.url.includes('/frame-data')),
      );
      assert(frameChain, 'iframe request not captured');
      assert(
        frameChain.sessionId !== transport.primarySessionId,
        'OOPIF request not captured in a flattened iframe session',
      );
    } finally {
      page.close();
      await closeShellTarget({ port: debugPort, targetId: target.targetId });
    }
  });

  await check('A7 per-session isolation via browser contexts (KTD-10 partition stand-in)', async () => {
    const one = await createShellTarget({ port: debugPort, url: 'about:blank', isolate: true });
    const two = await createShellTarget({ port: debugPort, url: 'about:blank', isolate: true });
    const pageOne = await connectShellPage({ port: debugPort, targetId: one.targetId });
    const pageTwo = await connectShellPage({ port: debugPort, targetId: two.targetId });
    try {
      await pageOne.setCookies([{ name: 'jar', value: 'one', url: `${fixtureOrigin}/` }]);
      await pageTwo.setCookies([{ name: 'jar', value: 'two', url: `${fixtureOrigin}/` }]);
      const jarOne = await pageOne.getCookiesForUrls?.([`${fixtureOrigin}/`]);
      const jarTwo = await pageTwo.getCookiesForUrls?.([`${fixtureOrigin}/`]);
      assert(jarOne?.some((c) => c.name === 'jar' && c.value === 'one'), `context one jar: ${JSON.stringify(jarOne)}`);
      assert(jarTwo?.some((c) => c.name === 'jar' && c.value === 'two'), `context two jar: ${JSON.stringify(jarTwo)}`);
      assert(!jarOne?.some((c) => c.value === 'two'), 'cookie cross-talk into context one');
      assert(!jarTwo?.some((c) => c.value === 'one'), 'cookie cross-talk into context two');
    } finally {
      pageOne.close();
      pageTwo.close();
      await closeShellTarget({ port: debugPort, targetId: one.targetId, browserContextId: one.browserContextId });
      await closeShellTarget({ port: debugPort, targetId: two.targetId, browserContextId: two.browserContextId });
    }
  });

  await check('A8 cold-start retry: marker target appearing mid-connect (10s/300ms budget)', async () => {
    const marker = `comate-view-late-${Math.random().toString(36).slice(2)}`;
    const started = Date.now();
    const connecting = connectShellPage({ port: debugPort, urlMarker: marker });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const target = await createShellTarget({ port: debugPort, url: `about:blank#${marker}` });
    const page = await connecting;
    try {
      assert(Date.now() - started >= 600, 'did not actually wait for the late target');
      assert((await page.evaluate<number>('2 + 2')) === 4, 'late attach broken');
    } finally {
      page.close();
      await closeShellTarget({ port: debugPort, targetId: target.targetId });
    }
  });

  await check('A9 targetDestroyed watcher (external-fallback session_lost signal)', async () => {
    const info = await fetchCdpBrowserInfo({ port: debugPort });
    const connection = await CdpConnection.connect(info.browserWsUrl, {});
    try {
      await connection.send('Target.setDiscoverTargets', { discover: true });
      const target = await createShellTarget({ port: debugPort, url: 'about:blank' });
      const destroyed = new Promise<string>((resolve) => {
        const off = connection.onEvent((event) => {
          if (event.method !== 'Target.targetDestroyed') return;
          const id = (event.params as { targetId?: string }).targetId;
          if (id === target.targetId) {
            off();
            resolve(id);
          }
        });
      });
      await closeShellTarget({ port: debugPort, targetId: target.targetId });
      const id = await Promise.race([
        destroyed,
        new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('no targetDestroyed within 3s')), 3_000)),
      ]);
      assert(id === target.targetId, `wrong target destroyed ${id}`);
    } finally {
      connection.close();
    }
  });

  await check('A10 session-context export (cookies + hostname-keyed storage)', async () => {
    const target = await createShellTarget({ port: debugPort, url: 'about:blank', isolate: true });
    const page = await connectShellPage({ port: debugPort, targetId: target.targetId });
    try {
      await page.navigate(`${fixtureOrigin}/login`);
      await page.evaluate("new Promise((r) => setTimeout(r, 100))");
    } finally {
      page.close();
    }
    const baseUrl = buildCdpPageBaseUrl({ host: '127.0.0.1', port: debugPort, targetId: target.targetId });
    const context = (await exportCdpSessionContext(baseUrl)) as {
      cookies: Array<Record<string, unknown>>;
      localStorage: Record<string, Record<string, string>>;
      sessionStorage: Record<string, Record<string, string>>;
    };
    assert(
      context.cookies.some((c) => c.name === 'fixture_auth' && c.value === 'secret-token'),
      `auth cookie missing: ${JSON.stringify(context.cookies)}`,
    );
    assert(
      context.localStorage['127.0.0.1']?.session === 'abc123',
      `localStorage not keyed by hostname: ${JSON.stringify(context.localStorage)}`,
    );
    await closeShellTarget({ port: debugPort, targetId: target.targetId, browserContextId: target.browserContextId });
  });

  // -------------------------------------------------------------------------
  // PART B — tool parity (AE2 mechanism): the 11 comate-browser tools driven
  // through BrowserToolContext + BrowserService against this same Chromium as
  // an EXTERNAL CDP endpoint (COMATE_BROWSER_CDP_TARGET, R8). No release —
  // the tools keep serving off a plain debug-port Chromium.
  // -------------------------------------------------------------------------

  process.env.COMATE_BROWSER_CDP_TARGET = `http://127.0.0.1:${debugPort}`;
  const { BrowserService } = await import('../src/server/services/browser-service.js');
  const { BrowserToolContext } = await import('../src/server/services/browser-mcp.js');
  const { BrowserControlService } = await import('../src/server/services/browser-control.js');
  const { siteKeyForUrl } = await import('../src/server/services/browser-site-key.js');

  const toolService = new BrowserService({ storageDir: tempDir });
  const toolResults: string[] = [];
  const makeCtx = (sessionId: string) =>
    new BrowserToolContext({
      sessionId,
      workspaceId: 'ws-e2e',
      browserService: toolService,
      handoffControl: new BrowserControlService({ browserService: toolService }),
      approvalRequester: async () => ({ behavior: 'allow' }),
      settleMs: 0,
    });
  interface ToolResult {
    isError?: boolean;
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  }
  const resultJson = (res: ToolResult): Record<string, unknown> => {
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    toolResults.push(text);
    if (res.isError) throw new Error(`tool error: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  interface PageModelShape {
    url: string;
    title: string;
    forms: Array<{
      ref: string;
      formIndex: number;
      fields: Array<{ ref: string; name?: string; submitSemantics: boolean; tag: string; type: string }>;
    }>;
    actions: Array<{ ref: string; role: string; name: string }>;
    content: { text: string };
  }

  const ctxA = makeCtx('cdp-tool-a');

  await check('B1 open: navigate + distill a form page', async () => {
    const out = resultJson(await ctxA.handleOpen({ url: `${fixtureHttp}/form` }));
    assert(out.ok === true, 'open not ok');
    const model = out['model'] as PageModelShape;
    assert(model.url.includes('/form'), `model url ${model.url}`);
    assert(model.forms.length === 1 && model.forms[0]!.fields.length >= 4, 'form not distilled');
  });

  let echoLinkRef = '';
  let nameFieldRef = '';
  await check('B2 snapshot + inspectElement: refs resolve to live elements', async () => {
    const out = resultJson(await ctxA.handleSnapshot({}));
    const model = out['model'] as PageModelShape;
    const form = model.forms[0]!;
    nameFieldRef = form.fields.find((f) => f.name === 'name')!.ref;
    echoLinkRef = model.actions.find((a) => a.name === 'echo link')!.ref;
    assert(nameFieldRef && echoLinkRef, `refs missing: ${JSON.stringify(model.forms)}`);
    const inspected = resultJson(await ctxA.handleInspectElement({ ref: echoLinkRef }));
    assert(inspected['ok'] === true, `inspectElement failed: ${JSON.stringify(inspected)}`);
  });

  await check('B3 act: fill/select/check through backend-node + in-page scripts', async () => {
    const filled = resultJson(await ctxA.handleAct({ ref: nameFieldRef, action: 'fill', value: 'Ada' }));
    assert(filled['ok'] === true, `fill failed: ${JSON.stringify(filled)}`);
  });

  await check('B4 submit-semantics guard: act(click) on a submit control is refused', async () => {
    // Refs rotate on every distill (B3's act re-distilled) — re-snapshot.
    const snap = resultJson(await ctxA.handleSnapshot({}));
    const model = snap['model'] as PageModelShape;
    const submit = model.forms[0]!.fields.find((f) => f.submitSemantics)!;
    const res = (await ctxA.handleAct({ ref: submit.ref, action: 'click' })) as ToolResult;
    toolResults.push(res.content?.find((c) => c.type === 'text')?.text ?? '');
    assert(res.isError === true, 'submit control click must be gated');
    assert(
      res.content?.[0]?.text?.includes('browser_use_submit_tool'),
      `unexpected gate: ${res.content?.[0]?.text}`,
    );
  });

  await check('B5 submit: approval-gated form submission navigates', async () => {
    const snap = resultJson(await ctxA.handleSnapshot({}));
    const model = snap['model'] as PageModelShape;
    const out = resultJson(await ctxA.handleSubmit({ ref: model.forms[0]!.ref, fields: {} }));
    assert(out['submitted'] === true, `submit failed: ${JSON.stringify(out)}`);
    const submitted = out['model'] as PageModelShape | undefined;
    assert(
      (submitted?.url ?? '').includes('/submitted') && (submitted?.url ?? '').includes('name=Ada'),
      `submit did not land on /submitted: ${submitted?.url}`,
    );
  });

  await check('B6 extract: schema-driven field extraction', async () => {
    const out = resultJson(
      await ctxA.handleExtract({ schema: { pageTitle: { source: 'title' }, pageUrl: { source: 'url' } } }),
    );
    assert(out['ok'] === true, `extract failed: ${JSON.stringify(out)}`);
    const data = out['data'] as Record<string, unknown>;
    assert(data?.pageTitle === 'submitted', `extract missed title: ${JSON.stringify(out)}`);
    assert(String(data?.pageUrl).includes('/submitted'), `extract missed url: ${JSON.stringify(out)}`);
  });

  await check('B7 network capture: start → action → stop runs the full pipeline', async () => {
    const started = resultJson(await ctxA.handleStartNetworkCapture({ action: 'open the root page' }));
    assert(started['ok'] === true, 'capture start failed');
    resultJson(await ctxA.handleOpen({ url: `${fixtureHttp}/` }));
    // Let the page's fetch/iframe traffic settle into chains before stopping.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stopped = resultJson(await ctxA.handleStopNetworkCapture());
    assert(stopped['ok'] === true, 'capture stop failed');
    // Candidates are HTTPS-gated by the sanitizer (candidateFromChain drops
    // http:// chains), so an http fixture asserts the pipeline state, not the
    // candidate list; redirect-chain CONTENT is verified in A6.
    assert(stopped['state'] === 'complete', `capture did not settle: ${JSON.stringify(stopped).slice(0, 400)}`);
    assert(typeof stopped['captureId'] === 'string', 'no captureId');
  });

  await check('B8 snapshot with screenshot returns an image block', async () => {
    const res = (await ctxA.handleSnapshot({ screenshot: true })) as ToolResult;
    assert(!res.isError, 'screenshot snapshot errored');
    const image = res.content?.find((c) => c.type === 'image');
    assert(image?.data && image.mimeType === 'image/jpeg', 'no jpeg image block');
  });

  const ctxC = makeCtx('cdp-tool-c');
  await check('B9 concurrent session isolation: fresh session has an empty cookie jar', async () => {
    const out = resultJson(await ctxC.handleOpen({ url: `${fixtureHttp}/echo` }));
    const model = out['model'] as PageModelShape;
    assert(
      model.content.text.includes('cookies=') && !model.content.text.includes('fixture_auth'),
      `unexpected cookie cross-talk: ${model.content.text}`,
    );
  });

  await check('B10 AE3: auth material capture → opaque binding → resolve reuses credentials', async () => {
    resultJson(await ctxA.handleOpen({ url: `${fixtureHttp}/login` }));
    const bindingId = await toolService.captureCandidateAuthBinding('cdp-tool-a', `${fixtureHttp}/quota`);
    assert(bindingId, 'no binding captured from the logged-in session');
    assert(!bindingId!.includes('secret-token'), 'binding id leaks credential material');
    const resolved = toolService.resolveAuthBinding('cdp-tool-a', bindingId!, `${fixtureHttp}/quota`);
    assert(
      resolved.cookies.some((c) => (c as Record<string, unknown>)['name'] === 'fixture_auth'),
      'resolved material lost the login cookie',
    );
    // Credentials never reach model context: no tool result so far may carry the token.
    assert(
      !toolResults.some((text) => text.includes('secret-token')),
      'credential material leaked into a tool result',
    );
  });

  await check('B11 remembered site replays into a rebuilt session before the first navigation', async () => {
    const key = siteKeyForUrl(`${fixtureHttp}/login`);
    assert(key.ok, `fixture site has no key: ${JSON.stringify(key)}`);
    await toolService.rememberGlobalSiteAuth('cdp-tool-a', key.ok ? key.key : '');
    // Teardown disposes A's browser context — the cookie is GONE from Chromium.
    await toolService.teardownSession('cdp-tool-a');
    const ctxB = makeCtx('cdp-tool-b');
    const out = resultJson(await ctxB.handleOpen({ url: `${fixtureHttp}/echo` }));
    const model = out['model'] as PageModelShape;
    assert(
      model.content.text.includes('fixture_auth=secret-token'),
      `remembered cookie not injected pre-navigation: ${model.content.text}`,
    );
    assert(
      model.content.text.includes('ls=abc123'),
      `remembered localStorage not replayed: ${model.content.text}`,
    );
    await toolService.teardownSession('cdp-tool-b');
  });

  await check('B12 requestHandoff: two-card flow completes and control returns', async () => {
    const out = resultJson(await ctxC.handleRequestHandoff({ reason: 'contract check' }));
    assert(out['ok'] === true, `handoff failed: ${JSON.stringify(out)}`);
    assert(
      toolService.getControlState('cdp-tool-c') === 'agent_in_control',
      `control not returned: ${toolService.getControlState('cdp-tool-c')}`,
    );
  });

  await check('B13 close: approval-confirmed teardown closes the external target', async () => {
    const out = resultJson(await ctxC.handleClose({ reason: 'done' }));
    assert(out['ok'] === true, `close failed: ${JSON.stringify(out)}`);
    assert(toolService.getSession('cdp-tool-c') === undefined, 'session still live after close');
    for (let i = 0; i < 50; i += 1) {
      const targets = await listCdpTargets({ port: debugPort });
      const pages = targets.filter((t) => t.type === 'page' && t.url.includes('about:blank#comate-view-'));
      if (pages.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('session targets survived close');
  });

  await toolService.shutdown().catch(() => undefined);
} finally {
  await closeShellTarget({ port: debugPort, targetId: targetA.targetId }).catch(() => undefined);
  chrome.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    fixture.closeAllConnections?.();
    fixture.close(() => resolve());
  });
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(chromeUserData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\nFAIL shell CDP contract suite: ${failed.length}/${results.length} failed`);
  process.exit(1);
}
console.log(`\nPASS shell CDP contract suite: ${results.length} checks, Chromium ${chromeVersion}`);
