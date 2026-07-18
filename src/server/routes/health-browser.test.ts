import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHealthBrowserRouter, type HealthBrowserDeps } from './health-browser.js';

/**
 * /api/health/browser contract (U2/R17/AE5): resolve-then-probe — 200 when the
 * vendored Steel bundle and a working Chromium both resolve; 503 with an
 * actionable remediation message otherwise (never a silent failure).
 */

type Handler = (req: unknown, res: unknown) => Promise<void>;

function getHandler(deps: Partial<HealthBrowserDeps>): Handler {
  const router = createHealthBrowserRouter(deps);
  const layers = (
    router as unknown as {
      stack: Array<{
        route?: { methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
      }>;
    }
  ).stack;
  for (const layer of layers) {
    if (layer.route && layer.route.methods.get) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error('GET handler not found');
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
  return res;
}

const steelOk = {
  steelDir: '/vendored/steel',
  entryPath: '/vendored/steel/build/index.js',
  source: 'resource' as const,
};
const chromiumOk = { executablePath: '/usr/bin/chromium', source: 'system' as const };

describe('health-browser route', { concurrency: false }, () => {
  it('returns 200 when steel and chromium resolve and the probe passes', async () => {
    const handler = getHandler({
      resolveSteel: () => steelOk,
      resolveChromium: async () => chromiumOk,
      probeChromium: async () => 'Chromium 151.0.7922.34',
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { ok: boolean; details: { chromium: { version: string } } };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.details.chromium.version, 'Chromium 151.0.7922.34');
  });

  it('prefers the resolver-provided version for downloaded builds', async () => {
    const handler = getHandler({
      resolveSteel: () => steelOk,
      resolveChromium: async () => ({ ...chromiumOk, source: 'download', version: '151.0.7922.34' }),
      probeChromium: async () => 'ignored',
    });
    const res = createMockRes();
    await handler({}, res);
    const body = res.jsonBody as { details: { chromium: { version: string } } };
    assert.strictEqual(body.details.chromium.version, '151.0.7922.34');
  });

  it('returns 503 with a remediation path when steel is missing', async () => {
    const handler = getHandler({
      resolveSteel: () => undefined,
      resolveChromium: async () => chromiumOk,
      probeChromium: async () => 'ok',
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /Steel bundle not found/);
    assert.match(body.error, /build:steel/);
  });

  it('returns 503 with a remediation path when chromium is missing', async () => {
    const handler = getHandler({
      resolveSteel: () => steelOk,
      resolveChromium: async () => undefined,
      probeChromium: async () => 'ok',
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /No Chromium executable found/);
    assert.match(body.error, /COMATE_CHROMIUM_PATH/);
  });

  it('reports both failures together', async () => {
    const handler = getHandler({
      resolveSteel: () => undefined,
      resolveChromium: async () => undefined,
      probeChromium: async () => 'ok',
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { error: string };
    assert.match(body.error, /Steel bundle not found/);
    assert.match(body.error, /No Chromium executable found/);
  });

  it('returns 503 when chromium resolves but fails to execute', async () => {
    const handler = getHandler({
      resolveSteel: () => steelOk,
      resolveChromium: async () => chromiumOk,
      probeChromium: async () => {
        throw new Error('exit code 1');
      },
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /failed to execute/);
  });
});
