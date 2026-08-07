import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHealthBrowserRouter, type HealthBrowserDeps } from './health-browser.js';

/**
 * /api/health/browser contract (U7/U9): resolve-then-probe over the native
 * stack — 200 when the active CDP target answers; 503 with a machine-readable
 * `code` and an actionable remediation message otherwise (never a silent
 * failure). The bundled-runtime / Chromium resolution branch left in U9.
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

describe('health-browser native classification (U7/U9)', () => {
  const shellTarget = {
    kind: 'shell' as const,
    debugPort: 49200,
    controlPort: 49300,
    controlToken: 'tok',
  };

  it('200 when control channel and debug port both answer (shell)', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => ({ ok: true, quitting: false }),
      probeDebugPort: async () => ({ product: 'Chrome/151.0.7922.34' }),
      lastShellError: () => undefined,
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { ok: boolean; details: Record<string, unknown> };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.details['target'], 'shell');
    assert.strictEqual(body.details['debugPort'], 49200);
    assert.strictEqual(body.details['controlPort'], 49300);
    assert.strictEqual(body.details['product'], 'Chrome/151.0.7922.34');
  });

  it('503 control_channel_unreachable with restart guidance', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => {
        throw new Error('fetch failed');
      },
      probeDebugPort: async () => ({ product: 'x' }),
      lastShellError: () => undefined,
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { ok: boolean; code: string; error: string };
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'control_channel_unreachable');
    assert.match(body.error, /Restart the desktop app/);
    assert.match(body.error, /dev-web/);
  });

  it('503 debug_port_unreachable when the debug port does not answer', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => ({ ok: true }),
      probeDebugPort: async () => {
        throw new Error('ECONNREFUSED');
      },
      lastShellError: () => undefined,
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'debug_port_unreachable');
    assert.match(body.error, /COMATE_BROWSER_CDP_TARGET/);
  });

  it('503 view_creation_failed surfaces the recorded spawn failure', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => ({ ok: true }),
      probeDebugPort: async () => ({ product: 'x' }),
      lastShellError: () => ({ kind: 'view_creation', message: 'renderer exploded', at: 1 }),
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'view_creation_failed');
    assert.match(body.error, /renderer exploded/);
  });

  it('classifies a recorded control_channel failure as control_channel_unreachable', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => ({ ok: true }),
      probeDebugPort: async () => ({ product: 'x' }),
      lastShellError: () => ({ kind: 'control_channel', message: 'channel dropped', at: 1 }),
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'control_channel_unreachable');
    assert.match(body.error, /channel dropped/);
  });

  it('classifies a recorded debug_port failure as debug_port_unreachable', async () => {
    const handler = getHandler({
      resolveTarget: () => shellTarget,
      probeControlChannel: async () => ({ ok: true }),
      probeDebugPort: async () => ({ product: 'x' }),
      lastShellError: () => ({ kind: 'debug_port', message: 'no marker', at: 1 }),
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'debug_port_unreachable');
    assert.match(body.error, /no marker/);
  });

  it('503 target_misconfigured surfaces the resolution reason', async () => {
    const handler = getHandler({
      resolveTarget: () => ({ kind: 'misconfigured', reason: 'bad COMATE_BROWSER_CDP_TARGET' }),
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'target_misconfigured');
    assert.match(body.error, /bad COMATE_BROWSER_CDP_TARGET/);
  });

  it('external target: 200 with endpoint + product when it answers', async () => {
    const external = { kind: 'external' as const, host: '127.0.0.1', port: 9222 };
    let probed: { host?: string; port: number } | undefined;
    const handler = getHandler({
      resolveTarget: () => external,
      probeDebugPort: async (address) => {
        probed = address;
        return { product: 'Chrome/151' };
      },
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(probed, { host: '127.0.0.1', port: 9222 });
    const body = res.jsonBody as { ok: boolean; details: Record<string, unknown> };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.details['target'], 'external');
    assert.strictEqual(body.details['endpoint'], '127.0.0.1:9222');
    assert.strictEqual(body.details['product'], 'Chrome/151');
  });

  it('external target: 503 debug_port_unreachable with external-endpoint guidance', async () => {
    const handler = getHandler({
      resolveTarget: () => ({ kind: 'external', host: '127.0.0.1', port: 9222 }),
      probeDebugPort: async () => {
        throw new Error('gone');
      },
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { code: string; error: string };
    assert.strictEqual(body.code, 'debug_port_unreachable');
    assert.match(body.error, /external CDP endpoint/);
  });
});
