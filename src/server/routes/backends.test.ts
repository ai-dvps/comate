import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createBackendRouter, type BackendRouteDeps } from './backends.js';

type Handler = (req: { body?: unknown }, res: ReturnType<typeof createMockRes>) => Promise<void> | void;

function getHandler(
  deps: BackendRouteDeps,
  method: 'get' | 'post' | 'put',
  routePath: string,
): Handler {
  const router = createBackendRouter(deps);
  const layers = (router as unknown as {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
    }>;
  }).stack;
  const layer = layers.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${routePath} handler not found`);
  return layer.route.stack[0].handle;
}

function createMockRes() {
  return {
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
}

function fakeDeps(overrides: Partial<BackendRouteDeps['codexAccount']> = {}): BackendRouteDeps {
  return {
    codexAccount: {
      read: async () => ({ account: null, requiresOpenaiAuth: true }),
      login: async () => ({ type: 'apiKey' }),
      cancelLogin: async () => undefined,
      logout: async () => undefined,
      listModels: async () => ({ data: [], nextCursor: null }),
      ...overrides,
    },
    codexSettings: {
      getDefaults: async () => ({}),
      setDefaults: async () => undefined,
    },
  };
}

describe('backend routes Codex account API', () => {
  it('validates and persists model-specific effort and speed defaults', async () => {
    let saved: unknown;
    const deps = fakeDeps({
      listModels: async () => ({
        data: [{
          model: 'gpt-5.6-codex',
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }],
          serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
        } as never],
        nextCursor: null,
      }),
    });
    deps.codexSettings.setDefaults = async (defaults) => { saved = defaults; };
    const handler = getHandler(deps, 'put', '/codex/defaults');
    const res = createMockRes();

    await handler({ body: { model: 'gpt-5.6-codex', effort: 'high', speed: 'fast' } }, res);

    assert.deepStrictEqual(saved, { model: 'gpt-5.6-codex', effort: 'high', speed: 'fast' });
    assert.deepStrictEqual(res.jsonBody, { model: 'gpt-5.6-codex', effort: 'high', speed: 'fast' });
  });

  it('rejects effort and speed values unavailable for the selected model', async () => {
    let saved = false;
    const deps = fakeDeps({
      listModels: async () => ({
        data: [{
          model: 'gpt-5.6-codex',
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
          serviceTiers: [],
        } as never],
        nextCursor: null,
      }),
    });
    deps.codexSettings.setDefaults = async () => { saved = true; };
    const handler = getHandler(deps, 'put', '/codex/defaults');

    const effortRes = createMockRes();
    await handler({ body: { model: 'gpt-5.6-codex', effort: 'ultra', speed: null } }, effortRes);
    assert.strictEqual(effortRes.statusCode, 400);

    const speedRes = createMockRes();
    await handler({ body: { model: 'gpt-5.6-codex', effort: null, speed: 'fast' } }, speedRes);
    assert.strictEqual(speedRes.statusCode, 400);
    assert.strictEqual(saved, false);
  });

  it('validates and persists an account-visible default model', async () => {
    let saved: string | null | undefined;
    const deps = fakeDeps({
      listModels: async () => ({
        data: [{ model: 'gpt-5.6-codex', hidden: false } as never],
        nextCursor: null,
      }),
    });
    deps.codexSettings.setDefaults = async (defaults) => { saved = defaults.model ?? null; };
    const handler = getHandler(deps, 'put', '/codex/model');
    const res = createMockRes();

    await handler({ body: { model: 'gpt-5.6-codex' } }, res);

    assert.strictEqual(saved, 'gpt-5.6-codex');
    assert.deepStrictEqual(res.jsonBody, { model: 'gpt-5.6-codex' });
  });

  it('rejects a model outside the native account catalog', async () => {
    let saved = false;
    const deps = fakeDeps();
    deps.codexSettings.setDefaults = async () => { saved = true; };
    const handler = getHandler(deps, 'put', '/codex/model');
    const res = createMockRes();

    await handler({ body: { model: 'unknown-model' } }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(saved, false);
  });

  it('returns native account state without exposing credentials', async () => {
    const handler = getHandler(fakeDeps({
      read: async () => ({
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }),
    }), 'get', '/codex/account');
    const res = createMockRes();

    await handler({}, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, {
      account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    });
  });

  it('starts browser login with the in-app completion options', async () => {
    let received: unknown;
    const handler = getHandler(fakeDeps({
      login: async (params) => {
        received = params;
        return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.com' };
      },
    }), 'post', '/codex/login');
    const res = createMockRes();

    await handler({ body: { type: 'chatgpt' } }, res);

    assert.deepStrictEqual(received, {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    });
    assert.deepStrictEqual(res.jsonBody, {
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://auth.example.com',
    });
  });

  it('passes an API key only to app-server and never echoes it', async () => {
    let received: unknown;
    const handler = getHandler(fakeDeps({
      login: async (params) => {
        received = params;
        return { type: 'apiKey' };
      },
    }), 'post', '/codex/login');
    const res = createMockRes();

    await handler({ body: { type: 'apiKey', apiKey: '  sk-secret  ' } }, res);

    assert.deepStrictEqual(received, { type: 'apiKey', apiKey: 'sk-secret' });
    assert.deepStrictEqual(res.jsonBody, { type: 'apiKey' });
    assert.ok(!JSON.stringify(res.jsonBody).includes('sk-secret'));
  });

  it('rejects unsupported login input before calling app-server', async () => {
    let called = false;
    const handler = getHandler(fakeDeps({
      login: async () => {
        called = true;
        return { type: 'apiKey' };
      },
    }), 'post', '/codex/login');
    const res = createMockRes();

    await handler({ body: { type: 'apiKey', apiKey: ' ' } }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false);
  });

  it('sanitizes app-server failures', async () => {
    const handler = getHandler(fakeDeps({
      read: async () => { throw new Error('request Authorization: Bearer sk-secret failed'); },
    }), 'get', '/codex/account');
    const res = createMockRes();

    await handler({}, res);

    assert.strictEqual(res.statusCode, 503);
    assert.ok(!JSON.stringify(res.jsonBody).includes('sk-secret'));
  });
});
