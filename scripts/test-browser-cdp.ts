import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CFT_PLATFORMS,
  CHROME_FOR_TESTING_VERSION,
  bundledCftZipRel,
  publishCftFromZip,
} from '../src/server/utils/cft-spec.js';
import { resolveSteelBundle } from '../src/server/utils/resolve-steel.js';
import { connectSteelPage } from '../src/server/services/browser-cdp.js';
import { BrowserNetworkCaptureManager } from '../src/server/services/browser-network-capture.js';

const required = process.env.COMATE_REQUIRE_BROWSER_CDP === '1' || process.argv.includes('--required');
const platformKey = `${process.platform}-${process.arch}`;
const spec = CFT_PLATFORMS[platformKey];
const resourceDir = path.resolve('src-tauri/resources');
const zipRel = bundledCftZipRel(platformKey);
const zipPath = zipRel ? path.join(resourceDir, zipRel) : undefined;
const steel = resolveSteelBundle({
  env: { ...process.env, TAURI_RESOURCE_DIR: resourceDir },
  storageDir: path.resolve('.browser-cdp-artifacts-absent'),
});

function unavailable(reason: string): never {
  if (required) throw new Error(`Browser CDP compatibility gate required but unavailable: ${reason}`);
  console.log(`SKIP browser CDP compatibility gate: ${reason}`);
  process.exit(0);
}

if (!spec) unavailable(`no pinned CfT spec for ${platformKey}`);
if (!zipPath || !existsSync(zipPath)) unavailable(`pinned CfT ${CHROME_FOR_TESTING_VERSION} bundle is absent`);
if (!steel) unavailable('vendored Steel bundle is absent');

const actualSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
if (actualSha !== spec.sha256) {
  throw new Error(`Pinned CfT checksum mismatch: expected ${spec.sha256}, got ${actualSha}`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'comate-browser-cdp-gate-'));
// BrowserService imports the process-wide SQLite store. Point that store at
// the disposable gate directory before loading the module so the compatibility
// probe never migrates or writes a developer's real Comate database.
process.env.COMATE_DATA_DIR = tempDir;
const { BrowserService } = await import('../src/server/services/browser-service.js');
const chromiumPath = await publishCftFromZip(
  zipPath,
  tempDir,
  spec,
  CHROME_FOR_TESTING_VERSION,
);
const fixtureRequests: string[] = [];
const server = createServer((request, response) => {
  fixtureRequests.push(request.url ?? '');
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/quota' });
    response.end();
    return;
  }
  if (request.url === '/quota') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ remaining: 42 }));
    return;
  }
  if (request.url === '/worker-quota') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ worker: true }));
    return;
  }
  if (request.url === '/frame-quota') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ frame: true }));
    return;
  }
  if (request.url === '/frame') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><script>
      fetch('/frame-quota').then(response => response.json()).then(() => parent.postMessage('frame-ready', '*'));
    </script>frame`);
    return;
  }
  if (request.url?.startsWith('/hang')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><script>
    const workerCode = 'postMessage("boot"); setTimeout(() => fetch(' + JSON.stringify(location.origin + '/worker-quota') + ').then(r => r.json()).then(v => { postMessage("quota"); postMessage("detach-ready"); fetch(' + JSON.stringify(location.origin + '/hang') + ') }), 200)';
    const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
    window.captureState = { redirect: false, worker: false, detached: false, frame: false };
    const frame = document.createElement('iframe');
    frame.src = 'http://localhost:' + location.port + '/frame';
    document.documentElement.appendChild(frame);
    addEventListener('message', event => { if (event.data === 'frame-ready') window.captureState.frame = true; });
    fetch('/redirect').then(response => response.json()).then(() => { window.captureState.redirect = true; });
    worker.onmessage = event => {
      if (event.data === 'boot') window.captureState.workerBooted = true;
      if (event.data === 'quota') window.captureState.worker = true;
      if (event.data === 'detach-ready') setTimeout(() => {
        worker.terminate();
        window.captureState.detached = true;
      }, 150);
    };
    worker.onerror = event => { window.captureState.workerError = String(event.message || 'worker error'); };
  </script>ready`);
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('CDP fixture server did not bind');

const service = new BrowserService({
  storageDir: tempDir,
  resolveChromiumPath: async () => chromiumPath,
});
let page: Awaited<ReturnType<typeof connectSteelPage>> | undefined;
try {
  const session = await service.ensureSession({ sessionId: 'cdp-gate', workspaceId: 'cdp-gate' });
  page = await connectSteelPage(session.baseUrl);
  const transport = page.createNetworkCaptureTransport?.();
  if (!transport) throw new Error('Pinned Steel/CfT pair did not expose CDP network capture');
  const targetEvents: Array<{ method: string; sessionId?: string; params?: unknown }> = [];
  const offTargetDebug = transport.onEvent((event) => {
    if (event.method.startsWith('Target.')) targetEvents.push(event);
  });
  const capture = new BrowserNetworkCaptureManager(transport, { quietMs: 50, hardDeadlineMs: 5_000 });
  await capture.start();
  await page.navigate(`http://127.0.0.1:${address.port}/`);
  let captureState: Record<string, boolean> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    captureState = await page.evaluate<Record<string, boolean>>('window.captureState || {}');
    if (captureState.redirect && captureState.worker && captureState.detached && captureState.frame) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!captureState.redirect || !captureState.worker || !captureState.detached || !captureState.frame) {
    throw new Error(`CDP fixture actions did not complete: ${JSON.stringify(captureState)} requests=${JSON.stringify(fixtureRequests)} targetEvents=${JSON.stringify(targetEvents)}`);
  }
  const result = await capture.stop();
  const redirect = result.chains.find((chain) => chain.hops.some((hop) => hop.request.url.endsWith('/redirect')));
  const redirectPaths = redirect?.hops.map((hop) => new URL(hop.request.url).pathname);
  if (JSON.stringify(redirectPaths) !== JSON.stringify(['/redirect', '/quota'])) {
    throw new Error(`Pinned Steel/CfT pair returned incorrect redirect hop order: ${JSON.stringify(redirectPaths)}`);
  }
  const finalBody = redirect?.hops.at(-1)?.responseBody?.body;
  if (!finalBody || JSON.parse(finalBody).remaining !== 42) {
    throw new Error('Pinned Steel/CfT pair did not retrieve the final redirect response body');
  }
  if (!fixtureRequests.includes('/worker-quota') || !fixtureRequests.includes('/hang')) {
    throw new Error(`Pinned Steel/CfT worker fixture did not execute: ${JSON.stringify(fixtureRequests)}`);
  }
  const frameChain = result.chains.find((chain) =>
    chain.hops.some((hop) => hop.request.url.endsWith('/frame-quota')));
  if (!frameChain || frameChain.sessionId === transport.primarySessionId) {
    throw new Error(`Pinned Steel/CfT OOPIF request was not captured in an iframe session: ${JSON.stringify(frameChain)}`);
  }
  if (!targetEvents.some((event) => event.method === 'Target.detachedFromTarget')) {
    throw new Error('Pinned Steel/CfT pair did not deliver worker target detach events');
  }
  if (result.state !== 'complete' || result.incompleteReasons.includes('deadline_exceeded')) {
    throw new Error(`Pinned Steel/CfT capture did not settle cleanly: ${JSON.stringify(result.incompleteReasons)}`);
  }
  const deadlineCapture = new BrowserNetworkCaptureManager(transport, {
    quietMs: 20,
    hardDeadlineMs: 100,
  });
  await deadlineCapture.start();
  await page.evaluate("fetch('/hang-main').catch(() => undefined)");
  const deadlineStarted = Date.now();
  const deadlineResult = await deadlineCapture.stop();
  const deadlineElapsed = Date.now() - deadlineStarted;
  const deadlineReasons = deadlineResult.chains.flatMap((chain) => chain.incompleteReasons);
  if (!deadlineReasons.includes('deadline_exceeded') || deadlineElapsed > 1_000) {
    throw new Error(`Pinned Steel/CfT deadline teardown failed: elapsed=${deadlineElapsed} result=${JSON.stringify(deadlineReasons)}`);
  }
  offTargetDebug();
  console.log(`PASS browser CDP compatibility: CfT ${CHROME_FOR_TESTING_VERSION}, Steel ${steel.source}; worker targets=lifecycle-only`);
} finally {
  page?.close();
  await service.teardownSession('cdp-gate').catch(() => undefined);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  await closed;
  rmSync(tempDir, { recursive: true, force: true });
}
