import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSettingsRouter, type SettingsRouteDeps } from './settings.js';

/**
 * /api/settings/browser contract: GET returns the resolved "allow insecure
 * certificates" value (default ON, threaded from the app-global store); PUT
 * validates a boolean and persists it. Handlers are exercised directly via the
 * factory's injectable get/set pair (mirrors health-browser), so no app-settings
 * file is touched.
 */

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

function getHandler(deps: Partial<SettingsRouteDeps>, method: 'get' | 'put'): Handler {
  const router = createSettingsRouter(deps);
  const layers = (
    router as unknown as {
      stack: Array<{
        route?: { methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
      }>;
    }
  ).stack;
  for (const layer of layers) {
    if (layer.route && layer.route.methods[method]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} handler not found`);
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

const createMockReq = (body?: unknown): { body: unknown } => ({ body });

function fakeDeps(overrides?: Partial<SettingsRouteDeps>): SettingsRouteDeps {
  return {
    getAllowInsecureCerts: async () => true,
    setAllowInsecureCerts: async () => undefined,
    ...overrides,
  };
}

describe('settings route (embedded-browser allow insecure certs)', () => {
  it('GET returns the resolved value when it is true', async () => {
    const handler = getHandler(fakeDeps({ getAllowInsecureCerts: async () => true }), 'get');
    const res = createMockRes();
    await handler(createMockReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { allowInsecureCerts: true });
  });

  it('GET returns false when the resolved value is false', async () => {
    const handler = getHandler(fakeDeps({ getAllowInsecureCerts: async () => false }), 'get');
    const res = createMockRes();
    await handler(createMockReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { allowInsecureCerts: false });
  });

  it('PUT true persists via the set dep and echoes the value', async () => {
    const setCalls: boolean[] = [];
    const handler = getHandler(
      fakeDeps({ setAllowInsecureCerts: async (v) => setCalls.push(v) }),
      'put',
    );
    const res = createMockRes();
    await handler(createMockReq({ allowInsecureCerts: true }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { allowInsecureCerts: true });
    assert.deepStrictEqual(setCalls, [true]);
  });

  it('PUT false persists via the set dep and echoes the value', async () => {
    const setCalls: boolean[] = [];
    const handler = getHandler(
      fakeDeps({ setAllowInsecureCerts: async (v) => setCalls.push(v) }),
      'put',
    );
    const res = createMockRes();
    await handler(createMockReq({ allowInsecureCerts: false }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { allowInsecureCerts: false });
    assert.deepStrictEqual(setCalls, [false]);
  });

  it('PUT rejects a non-boolean value with 400 and does not persist', async () => {
    let setCalled = false;
    const handler = getHandler(
      fakeDeps({ setAllowInsecureCerts: async () => { setCalled = true; } }),
      'put',
    );
    const res = createMockRes();
    await handler(createMockReq({ allowInsecureCerts: 'yes' }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(setCalled, false);
  });

  it('GET surfaces a read failure as 500', async () => {
    const handler = getHandler(
      fakeDeps({ getAllowInsecureCerts: async () => { throw new Error('disk gone'); } }),
      'get',
    );
    const res = createMockRes();
    await handler(createMockReq(), res);
    assert.strictEqual(res.statusCode, 500);
  });
});
