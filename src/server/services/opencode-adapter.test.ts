import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The adapter's pure helpers are exercised through its public surface where
// possible; these unit tests pin the translation rules the integration path
// relies on (provider mapping, permission reply translation, prompt text).

import type { Provider } from '../models/provider.js';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Test Provider',
    baseUrl: 'http://test',
    authToken: 'tok',
    model: 'test-model',
    isDefault: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('toAnthropicBaseUrl (via buildServeConfig)', () => {
  it('appends /v1 to a bare anthropic-compatible base URL', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    const config = __testables.buildServeConfig(makeProvider({ baseUrl: 'https://api.kimi.com/coding/' }), 'm');
    const provider = (config.provider as Record<string, { options: { baseURL: string } }>)['comate-p1'];
    assert.equal(provider.options.baseURL, 'https://api.kimi.com/coding/v1');
  });

  it('keeps a base URL that already ends with /v1', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    const config = __testables.buildServeConfig(makeProvider({ baseUrl: 'https://x.test/anthropic/v1' }), 'm');
    const provider = (config.provider as Record<string, { options: { baseURL: string } }>)['comate-p1'];
    assert.equal(provider.options.baseURL, 'https://x.test/anthropic/v1');
  });

  it('maps the comate provider into an anthropic-compatible opencode provider', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    const config = __testables.buildServeConfig(makeProvider(), 'test-model');
    const provider = (config.provider as Record<string, { npm: string; options: { apiKey: string }; models: Record<string, unknown> }>)['comate-p1'];
    assert.equal(provider.npm, '@ai-sdk/anthropic');
    assert.equal(provider.options.apiKey, 'tok');
    assert.ok(provider.models['test-model']);
  });

  it('asks for edit/bash/webfetch permissions and allows the question tool', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    const config = __testables.buildServeConfig(makeProvider(), 'm');
    assert.deepEqual(config.permission, { edit: 'ask', bash: 'ask', webfetch: 'ask', question: 'allow' });
  });
});

describe('toPermissionReply', () => {
  it('maps deny and null to reject, allow to once, allow+suggestions to always', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      workspaceId: 'w',
      directory: '/tmp',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const reply = (driver as unknown as { toPermissionReply: (r: unknown) => string }).toPermissionReply.bind(driver);
    assert.equal(reply(null), 'reject');
    assert.equal(reply({ behavior: 'deny' }), 'reject');
    assert.equal(reply({ behavior: 'allow', updatedInput: {} }), 'once');
    assert.equal(
      reply({
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
        ],
      }),
      'always',
    );
  });
});

describe('extractPromptText', () => {
  it('extracts string content and text blocks', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.equal(
      __testables.extractPromptText({ message: { role: 'user', content: 'hello' } } as never),
      'hello',
    );
    assert.equal(
      __testables.extractPromptText({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image' },
            { type: 'text', text: 'b' },
          ],
        },
      } as never),
      'a\nb',
    );
    assert.equal(__testables.extractPromptText({ message: { role: 'user' } } as never), '');
  });
});
