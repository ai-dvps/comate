import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHealthSandboxRouter, type HealthSandboxDeps } from './health-sandbox.js';
import type { SandboxProbeResult } from '../services/sandbox-probe.js';

/**
 * /api/health/sandbox contract (U3/KTD-24): 200 when the probe passes, 503
 * with the failure list when degraded; ?refresh=1 forces a re-probe (the
 * desktop banner's only clear path is a passing probe).
 */

type Handler = (req: unknown, res: unknown) => Promise<void>;

function getHandler(deps: Partial<HealthSandboxDeps>): Handler {
  const router = createHealthSandboxRouter(deps);
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

function probe(ok: boolean, failures: string[] = []): SandboxProbeResult {
  return { ok, platform: 'darwin', failures, checkedAt: Date.now(), durationMs: 3 };
}

describe('health-sandbox route', { concurrency: false }, () => {
  it('returns 200 with the probe result when the probe passes', async () => {
    const handler = getHandler({ ensureProbe: async () => probe(true) });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 200);
    const body = res.jsonBody as { ok: boolean; probe: SandboxProbeResult };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.probe.ok, true);
  });

  it('returns 503 with the failure list when degraded', async () => {
    const handler = getHandler({
      ensureProbe: async () => probe(false, ['filesystem-deny-not-enforced', 'network-deny-not-enforced']),
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    const body = res.jsonBody as { ok: boolean; error: string; probe: SandboxProbeResult };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /filesystem-deny-not-enforced/);
    assert.deepStrictEqual(body.probe.failures, ['filesystem-deny-not-enforced', 'network-deny-not-enforced']);
  });

  it('passes forceRefresh only when ?refresh=1', async () => {
    const calls: Array<{ forceRefresh?: boolean } | undefined> = [];
    const handler = getHandler({
      ensureProbe: async (options) => {
        calls.push(options);
        return probe(true);
      },
    });
    await handler({ query: {} }, createMockRes());
    await handler({ query: { refresh: '1' } }, createMockRes());
    await handler({ query: { refresh: '0' } }, createMockRes());
    assert.deepStrictEqual(calls, [{ forceRefresh: false }, { forceRefresh: true }, { forceRefresh: false }]);
  });

  it('returns 500 when the probe itself throws', async () => {
    const handler = getHandler({
      ensureProbe: async () => {
        throw new Error('spawn exploded');
      },
    });
    const res = createMockRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 500);
    const body = res.jsonBody as { ok: boolean; error: string };
    assert.strictEqual(body.ok, false);
    assert.match(body.error, /spawn exploded/);
  });
});
