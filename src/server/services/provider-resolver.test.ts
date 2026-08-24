import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderConfigurationV1 } from '../models/provider.js';
import { effectiveProviderResourceUrl, providerAvailability, providerResourceUrl, resolveProviderForAgent } from './provider-resolver.js';

const config: ProviderConfigurationV1 = {
  schemaVersion: 1,
  endpoints: {
    anthropic: { enabled: true, baseUrl: 'https://anthropic.example/api' },
    openai: { enabled: true, baseUrl: 'https://openai.example/coding/v1', format: 'openai-chat-completions' },
  },
  models: { claudeCode: 'claude-model', codex: 'codex-model', openCode: 'open-model' },
  openCode: { protocol: 'anthropic' },
  claude: {},
  codex: { effortByModel: { 'codex-model': ['low', 'xhigh'] } },
  preset: { id: 'kimi', version: 1 },
};

function provider(configuration: ProviderConfigurationV1 = config): Provider {
  return {
    id: 'p1', name: 'Provider', configuration, baseUrl: 'legacy-ignored', authToken: 'secret',
    isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('provider resolver', () => {
  it('selects only the requested Agent endpoint, model, and mode', () => {
    const claude = resolveProviderForAgent(provider(), 'claude');
    assert.equal(claude.available && claude.mode, 'direct-anthropic');
    assert.equal(claude.available && claude.model, 'claude-model');
    const codex = resolveProviderForAgent(provider(), 'codex');
    assert.equal(codex.available && codex.mode, 'codex-chat-route');
    assert.deepEqual(codex.available && codex.supportedEfforts, ['low', 'xhigh']);
    const opencode = resolveProviderForAgent(provider(), 'opencode');
    assert.equal(opencode.available && opencode.mode, 'direct-anthropic');
  });

  it('resolves OpenCode OpenAI Chat and fails closed for uncharacterized Responses', () => {
    const chat = structuredClone(config);
    chat.openCode.protocol = 'openai';
    assert.equal(resolveProviderForAgent(provider(chat), 'opencode').mode, 'direct-openai-chat');
    chat.endpoints.openai!.format = 'openai-responses';
    const opencodeResponses = resolveProviderForAgent(provider(chat), 'opencode');
    assert.equal(opencodeResponses.mode, 'unavailable');
    assert.equal(!opencodeResponses.available && opencodeResponses.reason, 'protocol-unsupported');
    assert.equal(resolveProviderForAgent(provider(chat), 'codex').mode, 'direct-openai-responses');
  });

  it('fails closed with stable reasons for missing configuration, endpoint, disabled endpoint, model, and credential', () => {
    const reason = (value: ReturnType<typeof resolveProviderForAgent>) => value.available ? undefined : value.reason;
    assert.equal(reason(resolveProviderForAgent({ ...provider(), configuration: undefined }, 'codex')), 'configuration-missing');
    const missing = structuredClone(config); delete missing.endpoints.openai;
    assert.equal(reason(resolveProviderForAgent(provider(missing), 'codex')), 'endpoint-missing');
    const disabled = structuredClone(config); disabled.endpoints.openai!.enabled = false;
    assert.equal(reason(resolveProviderForAgent(provider(disabled), 'codex')), 'endpoint-disabled');
    const blank = structuredClone(config); blank.endpoints.openai!.baseUrl = '   ';
    assert.equal(reason(resolveProviderForAgent(provider(blank), 'codex')), 'endpoint-invalid');
    const malformed = structuredClone(config); malformed.endpoints.openai!.baseUrl = 'https://user:pass@example.com/v1';
    assert.equal(reason(resolveProviderForAgent(provider(malformed), 'codex')), 'endpoint-invalid');
    const portZero = structuredClone(config); portZero.endpoints.openai!.baseUrl = 'http://llm.internal:0/v1';
    assert.equal(reason(resolveProviderForAgent(provider(portZero), 'codex')), 'endpoint-invalid');
    const noModel = structuredClone(config); delete noModel.models.codex;
    assert.equal(reason(resolveProviderForAgent(provider(noModel), 'codex')), 'model-missing');
    assert.equal(reason(resolveProviderForAgent({ ...provider(), authToken: '' }, 'codex')), 'credential-missing');
  });

  it('accepts HTTP endpoints, including internal hosts and non-standard ports', () => {
    const internal = structuredClone(config);
    internal.endpoints.anthropic!.baseUrl = 'http://llm.internal:8080/anthropic';
    internal.endpoints.openai!.baseUrl = 'http://10.20.30.40:9000/v1';

    const claude = resolveProviderForAgent(provider(internal), 'claude');
    const codex = resolveProviderForAgent(provider(internal), 'codex');
    assert.equal(claude.available && claude.baseUrl, 'http://llm.internal:8080/anthropic');
    assert.equal(codex.available && codex.baseUrl, 'http://10.20.30.40:9000/v1');
  });

  it('projects availability without URL or credential and never supports third-party speed', () => {
    const availability = providerAvailability(provider());
    assert.equal(JSON.stringify(availability).includes('secret'), false);
    assert.equal(JSON.stringify(availability).includes('openai.example'), false);
    assert.equal(availability.codex.speedSupported, false);
  });

  it('preserves versioned bases and avoids duplicate resource suffixes', () => {
    assert.equal(providerResourceUrl('https://api.kimi.com/coding/v1', 'models'), 'https://api.kimi.com/coding/v1/models');
    assert.equal(providerResourceUrl('https://open.bigmodel.cn/api/coding/paas/v4/', 'chat/completions'), 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    assert.equal(providerResourceUrl('https://example.com/v1/responses', 'responses'), 'https://example.com/v1/responses');
    assert.equal(providerResourceUrl('https://example.com/v1/chat', 'chat/completions'), 'https://example.com/v1/chat/completions');
  });

  it('builds exact protocol-aware Kimi and BigModel Anthropic/OpenAI model URLs', () => {
    const kimi = structuredClone(config);
    kimi.endpoints.anthropic!.baseUrl = 'https://api.kimi.com/coding';
    kimi.endpoints.openai!.baseUrl = 'https://api.kimi.com/coding/v1';
    assert.equal(effectiveProviderResourceUrl(resolveProviderForAgent(provider(kimi), 'claude') as never, 'models'), 'https://api.kimi.com/coding/v1/models');
    assert.equal(effectiveProviderResourceUrl(resolveProviderForAgent(provider(kimi), 'codex') as never, 'models'), 'https://api.kimi.com/coding/v1/models');

    const bigmodel = structuredClone(config);
    bigmodel.endpoints.anthropic!.baseUrl = 'https://open.bigmodel.cn/api/anthropic';
    bigmodel.endpoints.openai!.baseUrl = 'https://open.bigmodel.cn/api/coding/paas/v4';
    assert.equal(effectiveProviderResourceUrl(resolveProviderForAgent(provider(bigmodel), 'claude') as never, 'models'), 'https://open.bigmodel.cn/api/anthropic/v1/models');
    assert.equal(effectiveProviderResourceUrl(resolveProviderForAgent(provider(bigmodel), 'codex') as never, 'models'), 'https://open.bigmodel.cn/api/coding/paas/v4/models');

    const alreadyV1 = structuredClone(config);
    alreadyV1.endpoints.anthropic!.baseUrl = 'https://example.com/v1';
    assert.equal(effectiveProviderResourceUrl(resolveProviderForAgent(provider(alreadyV1), 'claude') as never, 'models'), 'https://example.com/v1/models');
  });
});
