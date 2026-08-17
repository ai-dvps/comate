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

  it('preserves a sanitized supplied image filename', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.deepEqual(__testables.extractPromptParts({
      message: { role: 'user', content: [{
        type: 'image',
        name: '../screenshots/login\u0000.png',
        source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
      }] },
    } as never), [{
      type: 'file',
      mime: 'image/png',
      filename: 'login.png',
      url: 'data:image/png;base64,AA==',
    }]);
  });

  it('encodes only valid UUIDs as reserved OpenCode message ids', async () => {
    const { __testables } = await import('./opencode-adapter.js');
    assert.equal(
      __testables.encodeComateMessageId('550e8400-e29b-41d4-a716-446655440000'),
      'msg_comate_550e8400e29b41d4a716446655440000',
    );
    assert.equal(__testables.encodeComateMessageId('not-a-uuid'), undefined);
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

  it('settles admission from prompt_async and forwards the stable message id', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/workspace',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const requests: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const clientTurnId = '550e8400-e29b-41d4-a716-446655440000';

    try {
      const internals = driver as unknown as {
        instance: { baseUrl: string; directory: string; authHeaders: Record<string, string> };
        backendSessionId: string;
        consumeInput: (input: AsyncIterable<SDKUserMessage>, options: Options) => void;
      };
      internals.instance = { baseUrl: 'http://opencode.test', directory: '/workspace', authHeaders: {} };
      internals.backendSessionId = 'oc-1';
      const admitted = driver.prepareAdmission(clientTurnId);
      internals.consumeInput((async function* () {
        yield {
          type: 'user',
          uuid: clientTurnId,
          parent_tool_use_id: null,
          message: { role: 'user', content: 'hello' },
        } as SDKUserMessage;
      })(), {} as Options);
      await admitted;
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0].messageID, 'msg_comate_550e8400e29b41d4a716446655440000');
  });

  it('rejects admission when prompt_async rejects the request', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/workspace',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const clientTurnId = '550e8400-e29b-41d4-a716-446655440000';

    try {
      const internals = driver as unknown as {
        instance: { baseUrl: string; directory: string; authHeaders: Record<string, string> };
        backendSessionId: string;
        consumeInput: (input: AsyncIterable<SDKUserMessage>, options: Options) => void;
      };
      internals.instance = { baseUrl: 'http://opencode.test', directory: '/workspace', authHeaders: {} };
      internals.backendSessionId = 'oc-1';
      const admitted = driver.prepareAdmission(clientTurnId);
      internals.consumeInput((async function* () {
        yield {
          type: 'user',
          uuid: clientTurnId,
          parent_tool_use_id: null,
          message: { role: 'user', content: 'hello' },
        } as SDKUserMessage;
      })(), {} as Options);
      await assert.rejects(admitted, /HTTP 503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('releases retry image bytes after terminal idle and error events', async () => {
    const { OpencodeBackendDriver, __testables } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/workspace',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const internals = driver as unknown as {
      lastPrompt?: { parts: unknown[] };
      sendPrompt: (parts: ReturnType<typeof __testables.extractPromptParts>, options: Options) => Promise<void>;
      routeEvent: (event: unknown, options: Options, sessionId: string) => void;
      instance: { baseUrl: string; directory: string; authHeaders: Record<string, string> };
      backendSessionId: string;
    };
    internals.instance = { baseUrl: 'http://opencode.test', directory: '/workspace', authHeaders: {} };
    internals.backendSessionId = 'oc-1';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const parts = __testables.extractPromptParts({ message: { role: 'user', content: [{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
    }] } } as never);

    try {
      await internals.sendPrompt(parts, {} as Options);
      assert.ok(internals.lastPrompt);
      internals.routeEvent({ type: 'session.idle', properties: { sessionID: 'oc-1' } }, {} as Options, 'oc-1');
      assert.equal(internals.lastPrompt, undefined);

      await internals.sendPrompt(parts, {} as Options);
      internals.routeEvent({
        type: 'session.error',
        properties: { sessionID: 'oc-1', error: { message: 'rate limit exceeded' } },
      }, {} as Options, 'oc-1');
      assert.equal(internals.lastPrompt, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the same image snapshot and message id for one model fallback', async () => {
    const { OpencodeBackendDriver } = await import('./opencode-adapter.js');
    const driver = new OpencodeBackendDriver({
      directory: '/workspace',
      comateSessionId: 's',
      provider: makeProvider(),
      env: {},
    });
    const parts = [{
      type: 'file' as const,
      mime: 'image/png',
      filename: 'screen.png',
      url: 'data:image/png;base64,AA==',
    }];
    const messageID = 'msg_comate_550e8400e29b41d4a716446655440000';
    let retried: { parts: unknown[]; messageID?: string } | undefined;
    const internals = driver as unknown as {
      modelID: string;
      lastPrompt?: { parts: typeof parts; messageID?: string };
      sendPrompt: (retryParts: typeof parts, options: Options, retryMessageID?: string) => Promise<void>;
      routeEvent: (event: unknown, options: Options, sessionId: string) => void;
    };
    internals.modelID = 'test-model[1m]';
    internals.lastPrompt = { parts, messageID };
    internals.sendPrompt = async (retryParts, _options, retryMessageID) => {
      retried = { parts: retryParts, messageID: retryMessageID };
    };

    internals.routeEvent({
      type: 'session.error',
      properties: { sessionID: 'oc-1', error: { message: 'model not found' } },
    }, {} as Options, 'oc-1');
    await Promise.resolve();

    assert.deepEqual(retried, { parts, messageID });
    assert.ok(internals.lastPrompt, 'fallback keeps bytes until the retry reaches a terminal event');
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
