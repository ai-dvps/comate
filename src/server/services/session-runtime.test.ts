import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionRuntime } from './session-runtime.js';
import type { SdkClient } from './sdk-client.js';
import type { Query, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';

describe('session-runtime activity callback', { concurrency: false }, () => {
  let activityCalls: number;
  let runtime: SessionRuntime | undefined;

  beforeEach(() => {
    activityCalls = 0;
  });

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(messages: SDKMessage[] = []): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const messageGen = (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();

    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: messageGen,
      }),
    } as unknown as SdkClient;
  }

  function createMockResponse(): import('express').Response {
    return {
      write: () => true,
    } as unknown as import('express').Response;
  }

  it('invokes onActivity on subscribe', () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      () => {
        activityCalls++;
      },
    );
    assert.strictEqual(activityCalls, 0);
    runtime.subscribe(createMockResponse());
    assert.strictEqual(activityCalls, 1);
  });

  it('invokes onActivity on pushMessage', () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      () => {
        activityCalls++;
      },
    );
    assert.strictEqual(activityCalls, 0);
    runtime.pushMessage('hello');
    assert.strictEqual(activityCalls, 1);
  });

  it('invokes onActivity for each SDK message in runMessageLoop', async () => {
    const messages: SDKMessage[] = [
      { type: 'text', text: 'hello' } as SDKMessage,
      { type: 'text', text: 'world' } as SDKMessage,
    ];
    const mockSdkClient = createMockSdkClient(messages);
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      () => {
        activityCalls++;
      },
    );

    // Allow the message loop to process the pre-staged messages.
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(activityCalls, 2);
  });

  it('does not invoke onActivity on unsubscribe', () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      () => {
        activityCalls++;
      },
    );
    runtime.subscribe(createMockResponse());
    assert.strictEqual(activityCalls, 1);
    runtime.unsubscribe(createMockResponse());
    assert.strictEqual(activityCalls, 1);
  });
});

describe('session-runtime idle state', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(messages: SDKMessage[] = []): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const messageGen = (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();

    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: messageGen,
      }),
    } as unknown as SdkClient;
  }

  it('fresh runtime is not processing a turn', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    assert.strictEqual(runtime.isProcessingTurn(), false);
  });

  it('runtime with currentMessageStartId is processing a turn', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = 'msg-1';
    assert.strictEqual(runtime.isProcessingTurn(), true);
  });

  it('runtime with pending approvals is processing a turn', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    // Inject a pending approval directly
    const pendingApprovals = (runtime as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;
    pendingApprovals.set('req-1', { resolve: () => {}, input: {}, type: 'approval' });
    assert.strictEqual(runtime.isProcessingTurn(), true);
  });

  it('runtime is not processing after both indicators clear', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = 'msg-1';
    const pendingApprovals = (runtime as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;
    pendingApprovals.set('req-1', { resolve: () => {}, input: {}, type: 'approval' });
    assert.strictEqual(runtime.isProcessingTurn(), true);

    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = undefined;
    pendingApprovals.clear();
    assert.strictEqual(runtime.isProcessingTurn(), false);
  });

  it('cancelIdleClose invokes onSubscribed callback', () => {
    let subscribedCalls = 0;
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      undefined,
      () => {
        subscribedCalls++;
      },
      undefined,
      undefined,
    );
    assert.strictEqual(subscribedCalls, 0);
    runtime.cancelIdleClose();
    assert.strictEqual(subscribedCalls, 1);
  });
});

describe('session-runtime timeout handling', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(messages: SDKMessage[] = []): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const messageGen = (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();

    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: messageGen,
      }),
    } as unknown as SdkClient;
  }

  function createMockResponse(): import('express').Response {
    return {
      write: () => true,
    } as unknown as import('express').Response;
  }

  function getCanUseToolCallback(runtime: SessionRuntime) {
    return (runtime as unknown as { buildCanUseToolCallback: () => (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[];
        title?: string;
        description?: string;
        toolUseID: string;
      },
    ) => Promise<PermissionResult> }).buildCanUseToolCallback();
  }

  function createAbortSignal(): AbortSignal {
    const controller = new AbortController();
    return controller.signal;
  }

  it('parses valid timeout and emits expiresAt in pending event', async () => {
    const events: Array<{ type: string; expiresAt?: number }> = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval' || event.type === 'pending_question') {
          events.push({ type: event.type, expiresAt: (event as { expiresAt?: number }).expiresAt });
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 5000 }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-1',
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'pending_approval');
    assert.ok(typeof events[0].expiresAt === 'number');
    assert.ok(events[0].expiresAt! > Date.now());
    assert.ok(events[0].expiresAt! <= Date.now() + 5000);

    runtime!.resolveApproval('tu-1', { behavior: 'allow' });
    await promise;
  });

  it('emits expiresAt for AskUserQuestion with timeout', async () => {
    const events: Array<{ type: string; expiresAt?: number }> = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval' || event.type === 'pending_question') {
          events.push({ type: event.type, expiresAt: (event as { expiresAt?: number }).expiresAt });
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('AskUserQuestion', {
      questions: [{ question: 'ok?', options: [{ label: 'yes' }], multiSelect: false }],
      timeout: 5000,
    }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-2',
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'pending_question');
    assert.ok(typeof events[0].expiresAt === 'number');

    runtime!.resolveApproval('tu-2', { behavior: 'deny', message: 'nope' });
    await promise;
  });

  it('ignores missing and invalid timeouts', async () => {
    const events: Array<{ type: string; expiresAt?: number }> = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval') {
          events.push({ type: event.type, expiresAt: (event as { expiresAt?: number }).expiresAt });
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);

    for (const timeout of [undefined, null, 0, -100, NaN, Infinity, 'abc']) {
      const toolUseID = `tu-invalid-${String(timeout)}`;
      const promise = callback('Bash', { command: 'echo hi', timeout }, {
        signal: createAbortSignal(),
        toolUseID,
      });
      await new Promise((r) => setTimeout(r, 10));
      const event = events.find((e) => e.expiresAt === undefined);
      assert.ok(event, `expected no expiresAt for timeout=${timeout}`);
      runtime!.resolveApproval(toolUseID, { behavior: 'deny', message: 'done' });
      await promise;
    }
  });

  it('fires timeout and resolves with fixed deny message', async () => {
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const result = await callback('Bash', { command: 'echo hi', timeout: 30 }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-timeout',
    });

    assert.strictEqual(result.behavior, 'deny');
    assert.strictEqual(result.message, 'Request timed out waiting for user response.');
  });

  it('user resolution before expiry cancels the timer', async () => {
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 1000 }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-resolved',
    });

    await new Promise((r) => setTimeout(r, 20));
    runtime.resolveApproval('tu-resolved', { behavior: 'allow' });

    const result = await promise;
    assert.strictEqual(result.behavior, 'allow');
  });

  it('SDK abort before expiry cancels the timer', async () => {
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
    );
    runtime.subscribe(createMockResponse());

    const controller = new AbortController();
    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 1000 }, {
      signal: controller.signal,
      toolUseID: 'tu-abort',
    });

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(result.message?.includes('aborted'));
  });

  it('close() cancels timers and resolves dangling requests', async () => {
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 1000 }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-close',
    });

    await new Promise((r) => setTimeout(r, 20));
    await runtime.close();

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(result.message?.includes('Session closed'));
  });

  it('subscribe() replay preserves expiresAt', async () => {
    const events: Array<{ type: string; expiresAt?: number }> = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval') {
          events.push({ type: event.type, expiresAt: (event as { expiresAt?: number }).expiresAt });
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 5000 }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-replay',
    });

    await new Promise((r) => setTimeout(r, 20));
    const firstEvent = events[events.length - 1];
    assert.ok(firstEvent.expiresAt);

    // Simulate reconnect by subscribing a second response
    runtime.subscribe(createMockResponse());
    await new Promise((r) => setTimeout(r, 20));

    const replayEvent = events[events.length - 1];
    assert.strictEqual(replayEvent.expiresAt, firstEvent.expiresAt);

    runtime!.resolveApproval('tu-replay', { behavior: 'allow' });
    await promise;
  });
});
