import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProviderModels, hasDefaultProviderChange, hasSnapshottedProviderChange, publicProvider, resolveProviderRequestAgent, runProviderHealthCheck } from './providers.js';
import type { Provider } from '../models/provider.js';
import type { BrowserDirectHttpRequest } from '../services/browser-direct-http-client.js';

function canonicalProvider(): Provider {
  return {
    id: 'provider-1',
    name: 'Canonical',
    configuration: {
      schemaVersion: 1,
      endpoints: { openai: { enabled: true, baseUrl: 'https://api.kimi.com/coding/v1', format: 'openai-chat-completions' } },
      models: { codex: 'kimi-k2.5' },
      openCode: { protocol: 'openai' },
      claude: { customEnvVars: { SAFE_NAME: 'round-trip-value' } },
      codex: { promptCacheRouting: 'auto', thinking: 'required', effortByModel: { 'kimi-k2.5': ['low'] } },
      preset: { id: 'kimi', version: 1 },
    },
    baseUrl: 'legacy', authToken: 'super-secret', isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('provider API projection', () => {
  it('preserves the legacy omitted-Agent contract while rejecting invalid explicit values', () => {
    assert.equal(resolveProviderRequestAgent(undefined), 'claude');
    assert.equal(resolveProviderRequestAgent('codex'), 'codex');
    assert.equal(resolveProviderRequestAgent('invalid'), undefined);
  });

  it('uses an explicit recursive allowlist, preserves canonical editable env values, and never exposes unknown fields', () => {
    const provider = canonicalProvider() as Provider & { futureSecret?: string };
    provider.futureSecret = 'future-secret';
    const projected = publicProvider(provider);

    assert.strictEqual(projected.authTokenPresent, true);
    assert.equal(projected.configuration?.codex.thinking, 'required');
    assert.equal(projected.configuration?.claude.customEnvVars?.SAFE_NAME, 'round-trip-value');
    assert.ok(!JSON.stringify(projected).includes('future-secret'));
    assert.ok(!JSON.stringify(projected).includes('super-secret'));
    assert.ok(!Object.hasOwn(projected, 'authToken'));
  });

  it('treats authoritative nested configuration edits as runtime snapshot changes', () => {
    const provider = canonicalProvider();
    const configuration = structuredClone(provider.configuration!);
    configuration.models.codex = 'edited-model';
    assert.equal(hasSnapshottedProviderChange({ configuration }, provider), true);
  });

  it('recognizes a pure default switch independently of configuration edits', () => {
    const provider = canonicalProvider();
    assert.equal(hasSnapshottedProviderChange({ isDefault: false }, provider), false);
    assert.equal(hasDefaultProviderChange({ isDefault: false }, provider), true);
    assert.equal(hasDefaultProviderChange({ isDefault: true }, provider), false);
  });

  it('does not issue health or discovery requests for incompatible selections', async () => {
    let requests = 0;
    const client = { request: async () => { requests += 1; throw new Error('unexpected'); } };
    const provider = canonicalProvider();
    assert.equal((await runProviderHealthCheck(provider, 'claude', client)).reason, 'endpoint-missing');
    assert.equal((await discoverProviderModels(provider, 'claude', client)).reason, 'endpoint-missing');
    assert.equal(requests, 0);
  });

  it('uses selected-Agent versioned model URL, rejects redirects, and attaches credentials only in the post-DNS hook', async () => {
    const provider = canonicalProvider();
    let captured: BrowserDirectHttpRequest | undefined;
    const client = {
      request: async (input: BrowserDirectHttpRequest) => {
        captured = input;
        return { url: input.url, method: 'GET', status: 200, headers: {}, body: Buffer.from('{}'), redirects: [] };
      },
    };
    assert.deepEqual(await runProviderHealthCheck(provider, 'codex', client), { ok: true });
    assert.equal(captured?.url, 'https://api.kimi.com/coding/v1/models');
    assert.equal(captured?.redirectPolicy, 'error');
    assert.equal(captured?.destinationPolicy, 'provider');
    assert.equal(JSON.stringify(captured?.headers).includes('super-secret'), false);
    assert.deepEqual(captured?.prepareHopHeaders?.({} as never, {} as never), { authorization: 'Bearer super-secret' });

    const modelsClient = {
      request: async (input: BrowserDirectHttpRequest) => ({
        url: input.url, method: 'GET', status: 200, headers: {},
        body: Buffer.from(JSON.stringify({ data: [{ id: 'kimi-k2.5' }, { id: 123 }, { secret: 'drop' }] })), redirects: [],
      }),
    };
    assert.deepEqual(await discoverProviderModels(provider, 'codex', modelsClient), { models: ['kimi-k2.5'] });
  });
});
