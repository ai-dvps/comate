import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyProviderPreset, getProviderPreset, listProviderPresets } from './provider-presets.js';

describe('provider presets', () => {
  it('publishes Kimi, BigModel, and Custom without credentials', () => {
    const presets = listProviderPresets();
    assert.deepEqual(presets.map(({ id }) => id), ['kimi', 'bigmodel', 'custom']);
    const serialized = JSON.stringify(presets);
    assert.equal(serialized.includes('authToken'), false);
    assert.equal(serialized.includes('authorization'), false);
  });

  it('copies documented protocol paths and explicit Kimi effort mapping', () => {
    const kimi = getProviderPreset('kimi')!;
    assert.equal(kimi.configuration.endpoints.openai?.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(kimi.configuration.endpoints.openai?.format, 'openai-chat-completions');
    assert.deepEqual(kimi.configuration.codex.modelProfiles?.['kimi-k2.5']?.supportedEfforts, ['low', 'high', 'xhigh']);
    assert.equal(kimi.configuration.codex.modelProfiles?.['kimi-k2.5']?.effortWireMapping?.xhigh, 'max');
    const bigmodel = getProviderPreset('bigmodel')!;
    assert.equal(bigmodel.configuration.endpoints.anthropic?.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(bigmodel.configuration.endpoints.openai?.baseUrl, 'https://open.bigmodel.cn/api/v1');
    assert.equal(bigmodel.configuration.endpoints.openai?.format, 'openai-responses');
    assert.equal(bigmodel.configuration.models.codex, 'glm-5.3');
    assert.equal(bigmodel.configuration.codex.modelProfiles?.['glm-5.3']?.contextWindow, 1_048_576);
    assert.equal(bigmodel.configuration.openCode.modelProfiles?.['glm-5.3']?.maxOutputTokens, undefined);
  });

  it('returns editable detached copies and never reapplies catalog changes', () => {
    const applied = applyProviderPreset('kimi')!;
    applied.endpoints.openai!.baseUrl = 'https://edited.example/v1';
    assert.equal(getProviderPreset('kimi')!.configuration.endpoints.openai?.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(applied.preset?.id, 'kimi');
  });
});
