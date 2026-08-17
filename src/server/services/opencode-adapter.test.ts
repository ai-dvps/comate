import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The adapter's pure helpers are exercised through its public surface where
// possible; these unit tests pin the translation rules the integration path
// relies on (provider mapping, permission reply translation, prompt text).

import type { Provider } from '../models/provider.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

async function* emptyInput(): AsyncGenerator<SDKUserMessage> {}

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
  it('uses the same task capability in the browser MCP Authorization header', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    const config = __testables.buildSessionMcpConfig('s1', 'same-task-token') as Record<
      string,
      { headers: { Authorization: string }; url: string }
    >;
    assert.equal(config['comate-browser'].headers.Authorization, 'Bearer same-task-token');
    assert.match(config['comate-browser'].url, /\/mcp\/browser\/s1$/);
  });

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

describe('extractPromptParts', () => {
  it('preserves mixed text/image order and emits native OpenCode file parts', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.deepEqual(
      __testables.extractPromptParts({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
            },
            { type: 'text', text: 'b' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/gif', data: 'R0lGODlh' },
            },
          ],
        },
      } as never),
      [
        { type: 'text', text: 'a' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'image-1.png',
          url: 'data:image/png;base64,aGVsbG8=',
        },
        { type: 'text', text: 'b' },
        {
          type: 'file',
          mime: 'image/gif',
          filename: 'image-2.gif',
          url: 'data:image/gif;base64,R0lGODlh',
        },
      ],
    );
  });

  it('supports legacy text and image-only turns', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.deepEqual(
      __testables.extractPromptParts({ message: { role: 'user', content: 'hello' } } as never),
      [{ type: 'text', text: 'hello' }],
    );
    assert.deepEqual(
      __testables.extractPromptParts({
        message: {
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' },
          }],
        },
      } as never),
      [{
        type: 'file',
        mime: 'image/jpeg',
        filename: 'image-1.jpg',
        url: 'data:image/jpeg;base64,/9j/',
      }],
    );
    assert.deepEqual(__testables.extractPromptParts({ message: { role: 'user' } } as never), []);
  });

  it('recognizes slash commands only for text-only turns', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.deepEqual(
      __testables.extractTextOnlySlashCommand([{ type: 'text', text: ' /review now ' }]),
      { name: 'review', args: 'now' },
    );
    assert.equal(
      __testables.extractTextOnlySlashCommand([
        { type: 'text', text: '/review now' },
        { type: 'file', mime: 'image/png', filename: 'image-1.png', url: 'data:image/png;base64,AA==' },
      ]),
      undefined,
    );
  });
});

describe('OpencodeBackendDriver multimodal prompt dispatch', () => {
  it('posts mixed and image-only turns to prompt_async without flattening file parts', async () => {
    const { OpencodeBackendDriver, __testables } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/workspace',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const internals = driver as unknown as {
        instance: { baseUrl: string; directory: string; authHeaders: Record<string, string> };
        backendSessionId: string;
        sendPrompt: (parts: ReturnType<typeof __testables.extractPromptParts>, options: Options) => Promise<void>;
      };
      internals.instance = { baseUrl: 'http://opencode.test', directory: '/workspace', authHeaders: {} };
      internals.backendSessionId = 'oc-1';

      const mixed = __testables.extractPromptParts({
        message: { role: 'user', content: [
          { type: 'text', text: '/review this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        ] },
      } as never);
      const imageOnly = __testables.extractPromptParts({
        message: { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGODlh' } },
        ] },
      } as never);
      await internals.sendPrompt(mixed, {} as Options);
      await internals.sendPrompt(imageOnly, {} as Options);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/session\/oc-1\/prompt_async\?/);
    assert.deepEqual(requests[0].body.parts, [
      { type: 'text', text: '/review this' },
      { type: 'file', mime: 'image/png', filename: 'image-1.png', url: 'data:image/png;base64,AA==' },
    ]);
    assert.deepEqual(requests[1].body.parts, [
      { type: 'file', mime: 'image/gif', filename: 'image-1.gif', url: 'data:image/gif;base64,R0lGODlh' },
    ]);
  });
});

describe('OpencodeBackendDriver model preprocessing', () => {
  it('strips claude-code alias suffix from the provider model at construction', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/tmp',
      comateSessionId: 's',
      provider: makeProvider({ model: 'glm-5.2[1m]' }),
      env: {},
    });
    assert.equal((driver as unknown as { modelID: string }).modelID, 'glm-5.2');
  });

  it('strips claude-code alias suffix when setModel is called', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/tmp',
      comateSessionId: 's',
      provider: makeProvider({ model: 'glm-5.2' }),
      env: {},
    });
    const { query } = driver.createStreamingQuery(emptyInput(), {} as Options);
    await query.setModel('k3[1m]');
    assert.equal((driver as unknown as { modelID: string }).modelID, 'k3');
    query.close();
  });
});

describe('OpencodeBackendDriver session titles', () => {
  it('forwards title updates for its backend session', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const received: string[] = [];
    const driver = new OpencodeBackendDriver({
      directory: '/tmp',
      comateSessionId: 's',
      backendSessionId: 'oc-1',
      provider: makeProvider(),
      env: {},
      onSessionTitle: (title) => received.push(title),
    });

    (driver as unknown as { routeEvent: (event: unknown, options: Options, sessionId: string) => void })
      .routeEvent({
        type: 'session.updated',
        properties: { sessionID: 'oc-1', info: { id: 'oc-1', title: 'New session - 2026-08-15T00:00:00.000Z' } },
      }, {} as Options, 'oc-1');
    (driver as unknown as { routeEvent: (event: unknown, options: Options, sessionId: string) => void })
      .routeEvent({
        type: 'session.updated',
        properties: { sessionID: 'oc-1', info: { id: 'oc-1', title: 'Fix login redirect' } },
      }, {} as Options, 'oc-1');

    assert.deepEqual(received, ['Fix login redirect']);
  });

  it('keeps routing title events when the observer throws', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const received: string[] = [];
    const driver = new OpencodeBackendDriver({
      directory: '/tmp',
      comateSessionId: 's',
      backendSessionId: 'oc-1',
      provider: makeProvider(),
      env: {},
      onSessionTitle: (title) => {
        received.push(title);
        if (received.length === 1) throw new Error('storage unavailable');
      },
    });
    const routeEvent = (event: unknown) =>
      (driver as unknown as { routeEvent: (event: unknown, options: Options, sessionId: string) => void })
        .routeEvent(event, {} as Options, 'oc-1');

    assert.doesNotThrow(() => routeEvent({
      type: 'session.updated',
      properties: { sessionID: 'oc-1', info: { id: 'oc-1', title: 'First generated title' } },
    }));
    assert.doesNotThrow(() => routeEvent({
      type: 'session.updated',
      properties: { sessionID: 'oc-1', info: { id: 'oc-1', title: 'Second generated title' } },
    }));

    assert.deepEqual(received, ['First generated title', 'Second generated title']);
  });
});
