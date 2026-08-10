import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionRuntime } from './session-runtime.js';
import type { SdkClient } from './sdk-client.js';
import type { Query, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent } from '../types/message.js';
import type { Provider } from '../models/provider.js';

function collectDiagLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalSidecar = process.env.COMATE_SIDECAR;
  process.env.COMATE_SIDECAR = '';
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      process.env.COMATE_SIDECAR = originalSidecar;
    },
  };
}

type RuntimeInternals = {
  ringBuffer: Array<{ id: string; event: SseEvent }>;
};

function activityEvents(events: SseEvent[]): Array<Record<string, unknown>> {
  return events.filter(
    (event) => (event as { type: string }).type === 'session_activity',
  ) as unknown as Array<Record<string, unknown>>;
}

function createActivitySdkClient(): {
  client: SdkClient;
  nextInput: () => Promise<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>;
  pushMessage: (message: SDKMessage) => void;
  failLoop: (error: Error) => void;
  finishLoop: () => void;
} {
  let inputIterator: AsyncIterator<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>;
  const queued: SDKMessage[] = [];
  let waiting:
    | {
        resolve: (result: IteratorResult<SDKMessage>) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  const messages = {
    async next(): Promise<IteratorResult<SDKMessage>> {
      const message = queued.shift();
      if (message) return { value: message, done: false };
      return new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SDKMessage>;

  const query = {
    interrupt: () => Promise.resolve(),
    close: () => waiting?.resolve({ value: undefined, done: true }),
    getContextUsage: () => Promise.resolve({
      totalTokens: 0,
      maxTokens: 1,
      percentage: 0,
      categories: [],
    }),
  } as unknown as Query;

  return {
    client: {
      createStreamingQuery: (input: AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>) => {
        inputIterator = input[Symbol.asyncIterator]();
        return { query, messages };
      },
    } as unknown as SdkClient,
    nextInput: async () => {
      const result = await inputIterator.next();
      assert.strictEqual(result.done, false);
      return result.value;
    },
    pushMessage: (message) => {
      if (waiting) {
        const current = waiting;
        waiting = undefined;
        current.resolve({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    failLoop: (error) => {
      const current = waiting;
      waiting = undefined;
      current?.reject(error);
    },
    finishLoop: () => {
      const current = waiting;
      waiting = undefined;
      current?.resolve({ value: undefined, done: true });
    },
  };
}

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

  it('does not report an activity transition on subscribe hydration', () => {
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
    assert.strictEqual(activityCalls, 0);
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

  it('does not invoke onActivity for each SDK message in runMessageLoop', async () => {
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
    assert.strictEqual(activityCalls, 0, 'streaming chunks should not bump the idle timer');
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
    assert.strictEqual(activityCalls, 0);
    runtime.unsubscribe(createMockResponse());
    assert.strictEqual(activityCalls, 0);
  });
});

describe('session-runtime mixed-channel unsubscribe guard', { concurrency: false }, () => {
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
    return { write: () => true } as unknown as import('express').Response;
  }

  function getWebEventHandlers(rt: SessionRuntime) {
    return (rt as unknown as { webEventHandlers: Set<unknown> }).webEventHandlers;
  }

  function getHeartbeatTimer(rt: SessionRuntime) {
    return (rt as unknown as { heartbeatTimer?: NodeJS.Timeout }).heartbeatTimer;
  }

  function getActiveRes(rt: SessionRuntime) {
    return (rt as unknown as { activeRes: import('express').Response | null }).activeRes;
  }

  it('keeps SSE state intact when a WebSocket handler unsubscribes while an SSE response is active', () => {
    let unsubscribedCalls = 0;
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      undefined,
      undefined,
      () => {
        unsubscribedCalls++;
      },
    );

    const res = createMockResponse();
    runtime.subscribe(res);
    assert.strictEqual(getActiveRes(runtime), res);
    assert.ok(getHeartbeatTimer(runtime));

    const handler = () => {};
    runtime.subscribeWebSocket(handler);
    runtime.unsubscribeWebSocket(handler);

    assert.strictEqual(getActiveRes(runtime), res);
    assert.ok(getHeartbeatTimer(runtime));
    assert.strictEqual(unsubscribedCalls, 0);
  });

  it('keeps other WebSocket handlers alive when one socket unsubscribes', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    runtime.subscribe(createMockResponse());

    const handler1 = () => {};
    const handler2 = () => {};
    runtime.subscribeWebSocket(handler1);
    runtime.subscribeWebSocket(handler2);
    assert.strictEqual(getWebEventHandlers(runtime).size, 2);

    runtime.unsubscribeWebSocket(handler1);

    assert.strictEqual(getWebEventHandlers(runtime).size, 1);
    assert.ok(getWebEventHandlers(runtime).has(handler2));
    assert.ok(getActiveRes(runtime));
    assert.ok(getHeartbeatTimer(runtime));
  });

  it('clears SSE state only after the SSE response and all web handlers are gone', () => {
    let unsubscribedCalls = 0;
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      undefined,
      undefined,
      () => {
        unsubscribedCalls++;
      },
    );

    const res = createMockResponse();
    runtime.subscribe(res);

    const handler = () => {};
    runtime.subscribeWebSocket(handler);

    // Drop the SSE response first; web handler still keeps the runtime subscribed.
    runtime.unsubscribe(res);
    assert.strictEqual(unsubscribedCalls, 0);

    // SSE state should already be cleared by the explicit SSE unsubscribe.
    // Now drop the web handler: with no SSE response and no web handlers,
    // unsubscribeWebSocket should be a no-op for SSE state.
    runtime.unsubscribeWebSocket(handler);
    assert.strictEqual(unsubscribedCalls, 1);
    assert.strictEqual(getActiveRes(runtime), null);
    assert.strictEqual(getHeartbeatTimer(runtime), undefined);
    assert.strictEqual(getWebEventHandlers(runtime).size, 0);
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

  it('a transcript replay marker alone does not own foreground activity', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = 'msg-1';
    assert.strictEqual(runtime.isProcessingTurn(), false);
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
        suggestions?: import('../types/message.js').PermissionSuggestion[];
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
    const events: Array<{ requestId: string; type: string; expiresAt?: number }> = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval') {
          events.push({
            requestId: (event as { requestId: string }).requestId,
            type: event.type,
            expiresAt: (event as { expiresAt?: number }).expiresAt,
          });
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
      const event = events.find((e) => e.requestId === toolUseID);
      assert.ok(event, `expected pending event for timeout=${timeout}`);
      assert.strictEqual(event.expiresAt, undefined, `expected no expiresAt for timeout=${timeout}`);
      runtime!.resolveApproval(toolUseID, { behavior: 'deny', message: 'done' });
      await promise;
    }
  });

  it('forwards decisionReasonType as denialReason on pending_approval', async () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'pending_approval') {
          events.push(event);
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'rm -rf /' }, {
      signal: createAbortSignal(),
      toolUseID: 'tu-safety',
      decisionReasonType: 'safetyCheck',
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(events.length, 1);
    const event = events[0];
    assert.strictEqual(event.type, 'pending_approval');
    assert.strictEqual((event as { denialReason?: string }).denialReason, 'safetyCheck');

    runtime!.resolveApproval('tu-safety', { behavior: 'deny', message: 'denied' });
    await promise;
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
    const { logs, restore } = collectDiagLogs();
    let result;
    try {
      result = await callback('Bash', { command: 'echo hi', timeout: 30 }, {
        signal: createAbortSignal(),
        toolUseID: 'tu-timeout',
      });
    } finally {
      restore();
    }

    assert.strictEqual(result.behavior, 'deny');
    assert.strictEqual(result.message, 'Request timed out waiting for user response.');
    assert.ok(
      logs.some((line) =>
        line.includes('reason=timeout') && line.includes('tool=Bash') && line.includes('toolUseId=tu-timeout')),
      'expected timeout reason to be logged',
    );
    assert.ok(!logs.some((line) => line.includes('command')), 'log line must not contain tool input');
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

    const { logs, restore } = collectDiagLogs();
    try {
      controller.abort();
    } finally {
      // Give the abort handler a tick to log before restoring console.
      await new Promise((r) => setTimeout(r, 0));
      restore();
    }

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(result.message?.includes('aborted'));
    assert.ok(
      logs.some((line) =>
        line.includes('reason=abort') && line.includes('tool=Bash') && line.includes('toolUseId=tu-abort')),
      'expected abort reason to be logged',
    );
    assert.ok(!logs.some((line) => line.includes('command')), 'log line must not contain tool input');
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

describe('session-runtime U8 audience + resolution provenance', { concurrency: false }, () => {
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

  it('stores the audience on the pending and exposes it via getPendingCardState', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const promise = runtime.requestToolApproval('req-aud', 'Bash', 'req-aud', { command: 'curl x' }, {
      timeout: 5000,
      audience: 'self',
    });
    await new Promise((r) => setTimeout(r, 20));

    const state = runtime.getPendingCardState('req-aud');
    assert.ok(state && state.type === 'approval');
    assert.strictEqual(state.audience, 'self');

    runtime.resolveApproval('req-aud', { behavior: 'allow' });
    await promise;
    assert.strictEqual(runtime.getPendingCardState('req-aud'), undefined);
  });

  it('pendings without an audience report undefined (non-escalation flow unchanged)', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const promise = runtime.requestToolApproval('req-plain', 'Bash', 'req-plain', { command: 'ls' }, {
      timeout: 5000,
    });
    await new Promise((r) => setTimeout(r, 20));

    const state = runtime.getPendingCardState('req-plain');
    assert.ok(state && state.type === 'approval');
    assert.strictEqual(state.audience, undefined);

    runtime.resolveApproval('req-plain', { behavior: 'allow' });
    await promise;
  });

  it('resolveApproval provenance is consumed exactly once', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const promise = runtime.requestToolApproval('req-prov', 'Bash', 'req-prov', { command: 'curl x' }, {
      timeout: 5000,
      audience: 'self',
    });
    await new Promise((r) => setTimeout(r, 20));

    runtime.resolveApproval('req-prov', { behavior: 'allow' }, {
      source: 'desktop',
      approver: { type: 'user' },
    });
    await promise;

    assert.deepStrictEqual(runtime.consumeResolutionProvenance('req-prov'), {
      source: 'desktop',
      approver: { type: 'user' },
    });
    assert.strictEqual(runtime.consumeResolutionProvenance('req-prov'), undefined);
  });

  it('timeoutDeny records provenance source=timeout', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const promise = runtime.requestToolApproval('req-ttl', 'Bash', 'req-ttl', { command: 'curl x' }, {
      timeout: 30,
      audience: 'self',
    });

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.deepStrictEqual(runtime.consumeResolutionProvenance('req-ttl'), { source: 'timeout' });
  });

  it('a resolve without provenance consumes as undefined (legacy callers)', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const promise = runtime.requestToolApproval('req-legacy', 'Bash', 'req-legacy', { command: 'ls' }, {
      timeout: 5000,
    });
    await new Promise((r) => setTimeout(r, 20));

    runtime.resolveApproval('req-legacy', { behavior: 'allow' });
    await promise;
    assert.strictEqual(runtime.consumeResolutionProvenance('req-legacy'), undefined);
  });
});

describe('session-runtime reconnect warning', { concurrency: false }, () => {
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

  function createCapturingResponse() {
    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as import('express').Response;
    return { res, writes };
  }

  function getRingBuffer(runtime: SessionRuntime) {
    return (runtime as unknown as { ringBuffer: Array<{ id: string; event: SseEvent }> }).ringBuffer;
  }

  it('does not emit missed-output warning when ring buffer is empty', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    runtime.subscribe(createMockResponse(), 'stale-event-id');
    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 0);
  });

  it('emits missed-output warning and replays buffered events when lastEventId is stale', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    const ringBuffer = getRingBuffer(runtime);
    ringBuffer.push(
      { id: '1', event: { type: 'text_delta', messageId: 'm1', partIndex: 0, text: 'hello' } },
      { id: '2', event: { type: 'text_delta', messageId: 'm1', partIndex: 1, text: 'world' } },
    );

    const { res, writes } = createCapturingResponse();
    runtime.subscribe(res, '-1');

    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 1);
    assert.ok(writes.some((w) => w.includes('id: 1')));
    assert.ok(writes.some((w) => w.includes('id: 2')));
  });

  it('replays subsequent events without warning when lastEventId is found in ring buffer', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    const ringBuffer = getRingBuffer(runtime);
    ringBuffer.push(
      { id: '1', event: { type: 'text_delta', messageId: 'm1', partIndex: 0, text: 'first' } },
      { id: '2', event: { type: 'text_delta', messageId: 'm1', partIndex: 1, text: 'second' } },
      { id: '3', event: { type: 'text_delta', messageId: 'm1', partIndex: 2, text: 'third' } },
    );

    const { res, writes } = createCapturingResponse();
    runtime.subscribe(res, '1');

    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 0);
    assert.ok(writes.some((w) => w.includes('id: 2')));
    assert.ok(writes.some((w) => w.includes('id: 3')));
    assert.ok(writes[1].includes('id: 2'));
    assert.ok(writes[2].includes('id: 3'));
  });

  it('replays subsequent events without warning when lastEventId is found in ring buffer via WebSocket', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    const ringBuffer = getRingBuffer(runtime);
    ringBuffer.push(
      { id: '1', event: { type: 'text_delta', messageId: 'm1', partIndex: 0, text: 'first' } },
      { id: '2', event: { type: 'text_delta', messageId: 'm1', partIndex: 1, text: 'second' } },
      { id: '3', event: { type: 'text_delta', messageId: 'm1', partIndex: 2, text: 'third' } },
    );

    const replayed: SseEvent[] = [];
    runtime.subscribeWebSocket((_id, event) => {
      replayed.push(event);
    }, '1');

    assert.ok(
      replayed.some((e) => e.type === 'text_delta' && (e as { text?: string }).text === 'second'),
      'second text_delta should be replayed',
    );
    assert.ok(
      replayed.some((e) => e.type === 'text_delta' && (e as { text?: string }).text === 'third'),
      'third text_delta should be replayed',
    );
    assert.ok(
      !replayed.some((e) => e.type === 'text_delta' && (e as { text?: string }).text === 'first'),
      'first text_delta (the matched lastEventId) should not be replayed',
    );
    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 0);
  });

  it('replays assistant_start inclusively for fresh WebSocket subscriptions mid-turn', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    const ringBuffer = getRingBuffer(runtime);
    ringBuffer.push(
      { id: 'start-1', event: { type: 'assistant_start', messageId: 'm1' } },
      { id: '2', event: { type: 'text_delta', messageId: 'm1', partIndex: 0, text: 'hello' } },
    );
    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = 'start-1';

    const replayed: SseEvent[] = [];
    runtime.subscribeWebSocket((_id, event) => {
      replayed.push(event);
    });

    assert.ok(replayed.some((e) => e.type === 'assistant_start'), 'assistant_start should be replayed');
    assert.ok(replayed.some((e) => e.type === 'text_delta'), 'text_delta should be replayed');
    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 0);
  });

  it('does not emit warning when currentMessageStartId is set but ring buffer is empty', () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        events.push(event);
      },
    );
    (runtime as unknown as { currentMessageStartId?: string }).currentMessageStartId = 'start-id';
    runtime.subscribe(createMockResponse());
    assert.strictEqual(events.filter((e) => e.type === 'error_note').length, 0);
  });
});

describe('session-runtime rate-limit errors', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createThrowingSdkClient(err: Error): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const messageGen = (async function* () {
      throw err;
      yield undefined as unknown as SDKMessage;
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

  it('emits rate_limit event when the thrown error carries rate_limit_info', async () => {
    const events: SseEvent[] = [];
    const err = Object.assign(new Error('Rate limit exceeded'), {
      error: 'rate_limit',
      rate_limit_info: {
        status: 'rejected',
        errorCode: 'credits_required',
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: false,
      },
    });

    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createThrowingSdkClient(err),
      (_id, event) => events.push(event),
    );
    runtime.subscribe(createMockResponse());

    await new Promise((r) => setTimeout(r, 50));

    const rateLimit = events.find((e): e is Extract<SseEvent, { type: 'rate_limit' }> => e.type === 'rate_limit');
    assert.ok(rateLimit, 'expected a rate_limit event');
    assert.strictEqual(rateLimit.errorCode, 'credits_required');
    assert.strictEqual(rateLimit.canUserPurchaseCredits, true);
    assert.strictEqual(rateLimit.hasChargeableSavedPaymentMethod, false);
    assert.ok(events.some((e) => e.type === 'error_note'), 'expected a backward-compat error_note');
  });

  it('falls back to error_note for rate-limit-like errors without rate_limit_info', async () => {
    const events: SseEvent[] = [];
    const err = Object.assign(new Error('overloaded'), { error: 'overloaded' });

    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createThrowingSdkClient(err),
      (_id, event) => events.push(event),
    );
    runtime.subscribe(createMockResponse());

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!events.some((e) => e.type === 'rate_limit'));
    assert.ok(events.some((e) => e.type === 'error_note'));
  });
});

describe('session-runtime context_usage emission', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(getContextUsage: Query['getContextUsage']): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
      getContextUsage,
    } as unknown as Query;

    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: (async function* () {})(),
      }),
    } as unknown as SdkClient;
  }

  function createMockResponse(): import('express').Response {
    return { write: () => true } as unknown as import('express').Response;
  }

  function getEmitter(runtime: SessionRuntime) {
    return (runtime as unknown as { emitter: { emitEvent: (event: SseEvent) => void } }).emitter;
  }

  it('emits context_usage after lifecycle events', async () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(() =>
        Promise.resolve({
          totalTokens: 100,
          maxTokens: 200000,
          percentage: 5,
          categories: [{ name: 'messages', tokens: 100, color: '#000' }],
        } as Awaited<ReturnType<Query['getContextUsage']>>),
      ),
      (_id, event) => events.push(event),
    );
    runtime.subscribe(createMockResponse());
    const emitter = getEmitter(runtime);

    emitter.emitEvent({ type: 'assistant_start', messageId: 'm1' });
    await new Promise((r) => setTimeout(r, 30));

    const contextUsage = events.find(
      (e): e is Extract<SseEvent, { type: 'context_usage' }> => e.type === 'context_usage',
    );
    assert.ok(contextUsage, 'expected context_usage event');
    assert.strictEqual(contextUsage.totalTokens, 100);
    assert.strictEqual(contextUsage.maxTokens, 200000);
    assert.strictEqual(contextUsage.percentage, 5);
    assert.strictEqual(contextUsage.categories.length, 1);
    assert.strictEqual(contextUsage.categories[0].name, 'messages');
    assert.strictEqual(contextUsage.categories[0].tokens, 100);
  });

  it('emits context_usage for each lifecycle event type', async () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(() =>
        Promise.resolve({
          totalTokens: 10,
          maxTokens: 200000,
          percentage: 1,
          categories: [],
        } as Awaited<ReturnType<Query['getContextUsage']>>),
      ),
      (_id, event) => events.push(event),
    );
    runtime.subscribe(createMockResponse());
    const emitter = getEmitter(runtime);

    emitter.emitEvent({ type: 'tool_result', toolUseId: 'tu-1', output: '', isError: false });
    emitter.emitEvent({ type: 'assistant_done', messageId: 'm1' });
    emitter.emitEvent({ type: 'result', subtype: 'success', isError: false });
    emitter.emitEvent({ type: 'compact_boundary' });
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(events.filter((e) => e.type === 'context_usage').length, 4);
  });

  it('does not emit context_usage when getContextUsage rejects', async () => {
    const events: SseEvent[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(() => Promise.reject(new Error('usage unavailable'))),
      (_id, event) => events.push(event),
    );
    runtime.subscribe(createMockResponse());
    const emitter = getEmitter(runtime);

    emitter.emitEvent({ type: 'assistant_start', messageId: 'm1' });
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(!events.some((e) => e.type === 'context_usage'));
    assert.ok(!events.some((e) => e.type === 'error_note'));
  });
});

describe('session-runtime cancelPendingApprovals', { concurrency: false }, () => {
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
    return { write: () => true } as unknown as import('express').Response;
  }

  function getCanUseToolCallback(runtime: SessionRuntime) {
    return (runtime as unknown as { buildCanUseToolCallback: () => (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: import('../types/message.js').PermissionSuggestion[];
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

  it('resolves pending tool approvals as denied', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi' }, { signal: createAbortSignal(), toolUseID: 'tu-1' });

    await new Promise((r) => setTimeout(r, 20));
    runtime.cancelPendingApprovals('Turn interrupted by user.');

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.strictEqual(result.message, 'Turn interrupted by user.');
  });

  it('resolves pending questions as denied', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('AskUserQuestion', {
      questions: [{ question: 'ok?', options: [{ label: 'yes' }], multiSelect: false }],
    }, { signal: createAbortSignal(), toolUseID: 'tu-2' });

    await new Promise((r) => setTimeout(r, 20));
    runtime.cancelPendingApprovals('Turn interrupted by user.');

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.strictEqual(result.message, 'Turn interrupted by user.');
  });

  it('emits approval_resolved for each pending entry', async () => {
    const resolvedRequestIds: string[] = [];
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(),
      (_id, event) => {
        if (event.type === 'approval_resolved') {
          resolvedRequestIds.push((event as { requestId: string }).requestId);
        }
      },
    );
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const p1 = callback('Bash', { command: 'echo hi' }, { signal: createAbortSignal(), toolUseID: 'tu-1' });
    const p2 = callback('AskUserQuestion', {
      questions: [{ question: 'ok?', options: [{ label: 'yes' }], multiSelect: false }],
    }, { signal: createAbortSignal(), toolUseID: 'tu-2' });

    await new Promise((r) => setTimeout(r, 20));
    runtime.cancelPendingApprovals('Turn interrupted by user.');

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(resolvedRequestIds.sort(), ['tu-1', 'tu-2']);
  });

  it('clears timeout timers for cancelled approvals', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi', timeout: 60000 }, { signal: createAbortSignal(), toolUseID: 'tu-1' });

    await new Promise((r) => setTimeout(r, 20));
    const pending = (runtime as unknown as { pendingApprovals: Map<string, { timer?: NodeJS.Timeout }> }).pendingApprovals;
    assert.ok(pending.get('tu-1')?.timer);

    runtime.cancelPendingApprovals('Turn interrupted by user.');

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
    assert.strictEqual(pending.get('tu-1')?.timer, undefined);
  });

  it('is safe to call when no approvals are pending', () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    assert.doesNotThrow(() => {
      runtime!.cancelPendingApprovals('Turn interrupted by user.');
    });
  });

  it('is safe to call twice on the same runtime', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    runtime.subscribe(createMockResponse());

    const callback = getCanUseToolCallback(runtime);
    const promise = callback('Bash', { command: 'echo hi' }, { signal: createAbortSignal(), toolUseID: 'tu-1' });

    await new Promise((r) => setTimeout(r, 20));
    runtime.cancelPendingApprovals('Turn interrupted by user.');
    runtime.cancelPendingApprovals('Turn interrupted by user.');

    const result = await promise;
    assert.strictEqual(result.behavior, 'deny');
  });
});

describe('session-runtime Kimi loop detection', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(): SdkClient & { capturedOptions?: Options } {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const client = {
      createStreamingQuery: (_input: unknown, options: Options) => {
        client.capturedOptions = options;
        return {
          query: mockQuery,
          messages: (async function* () {})(),
        };
      },
    } as SdkClient & { capturedOptions?: Options };

    return client;
  }

  function createAbortSignal(): AbortSignal {
    return new AbortController().signal;
  }

  function createOptions(): Options {
    return {
      canUseTool: async (_toolName, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
    } as Options;
  }

  function createKimiProvider(): Provider {
    return {
      id: 'kimi',
      name: 'Kimi Provider',
      baseUrl: 'https://api.moonshot.cn/v1',
      authToken: 'test',
      model: 'kimi-k2',
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function createAnthropicProvider(): Provider {
    return {
      id: 'anthropic',
      name: 'Anthropic Provider',
      baseUrl: 'https://api.anthropic.com',
      authToken: 'test',
      model: 'claude-3-5-sonnet',
      isDefault: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it('denies repeated identical tool calls for Kimi providers', async () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      createOptions(),
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      undefined,
      createKimiProvider(),
    );

    const options = mockSdkClient.capturedOptions!;
    const signal = createAbortSignal();

    assert.strictEqual(
      (await options.canUseTool!('Read', { file_path: '/a.txt' }, { signal, toolUseID: 'tu-1' })).behavior,
      'allow',
    );
    assert.strictEqual(
      (await options.canUseTool!('Read', { file_path: '/a.txt' }, { signal, toolUseID: 'tu-2' })).behavior,
      'allow',
    );

    const result = await options.canUseTool!(
      'Read',
      { file_path: '/a.txt' },
      { signal, toolUseID: 'tu-3' },
    );
    assert.strictEqual(result.behavior, 'deny');
    assert.ok(
      (result as { message: string }).message.includes('already called Read'),
    );
  });

  it('does not deny repeated identical tool calls for non-Kimi providers', async () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      createOptions(),
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      undefined,
      createAnthropicProvider(),
    );

    const options = mockSdkClient.capturedOptions!;
    const signal = createAbortSignal();

    for (let i = 0; i < 5; i++) {
      const result = await options.canUseTool!(
        'Read',
        { file_path: '/a.txt' },
        { signal, toolUseID: `tu-${i}` },
      );
      assert.strictEqual(result.behavior, 'allow');
    }
  });

  it('resets the detector when a new user message is pushed', async () => {
    const mockSdkClient = createMockSdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      createOptions(),
      mockSdkClient,
      undefined,
      undefined,
      undefined,
      undefined,
      createKimiProvider(),
    );

    const options = mockSdkClient.capturedOptions!;
    const signal = createAbortSignal();

    // Trigger two repeats so the next identical call would deny.
    await options.canUseTool!('Read', { file_path: '/a.txt' }, { signal, toolUseID: 'tu-1' });
    await options.canUseTool!('Read', { file_path: '/a.txt' }, { signal, toolUseID: 'tu-2' });

    runtime.pushMessage('continue');

    const result = await options.canUseTool!(
      'Read',
      { file_path: '/a.txt' },
      { signal, toolUseID: 'tu-3' },
    );
    assert.strictEqual(result.behavior, 'allow');
  });
});

describe('session-runtime authoritative activity', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) await runtime.close();
    runtime = undefined;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('owns foreground synchronously and stamps submitted messages with a UUID', async () => {
    const events: SseEvent[] = [];
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      (_id, event) => events.push(event),
    );

    runtime.pushMessage('hello');

    assert.deepStrictEqual(
      (runtime as unknown as { getActivitySnapshot(): unknown }).getActivitySnapshot(),
      { phase: 'foreground', active: true, backgroundTasks: [] },
    );
    assert.deepStrictEqual(activityEvents(events), [
      { type: 'session_activity', phase: 'foreground', active: true, backgroundTasks: [] },
    ]);
    const submitted = await sdk.nextInput();
    assert.match(submitted.uuid ?? '', /^[0-9a-f-]{36}$/i);
  });

  it('uses background task snapshots as replace-state and result ends foreground only', async () => {
    const events: SseEvent[] = [];
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      (_id, event) => events.push(event),
    );
    runtime.pushMessage('start');

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'a', task_type: 'agent', description: 'Research' },
        { task_id: 'b', task_type: 'bash', description: 'Build' },
      ],
      uuid: 'snapshot-1',
      session_id: 's1',
    } as SDKMessage);
    await tick();
    sdk.pushMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      parent_tool_use_id: null,
    } as SDKMessage);
    await tick();

    assert.deepStrictEqual(
      (runtime as unknown as { getActivitySnapshot(): unknown }).getActivitySnapshot(),
      {
        phase: 'background',
        active: true,
        backgroundTasks: [
          { id: 'a', type: 'agent', description: 'Research' },
          { id: 'b', type: 'bash', description: 'Build' },
        ],
      },
    );

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b', task_type: 'bash', description: 'Build' }],
      uuid: 'snapshot-2',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    assert.deepStrictEqual(
      (runtime as unknown as { getActivitySnapshot(): unknown }).getActivitySnapshot(),
      {
        phase: 'background',
        active: true,
        backgroundTasks: [{ id: 'b', type: 'bash', description: 'Build' }],
      },
    );
  });

  it('correlates a live background subagent with its parent tool use', async () => {
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      () => {},
    );

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'agent-1', task_type: 'agent', description: 'Research' }],
      uuid: 'snapshot-1',
      session_id: 's1',
    } as SDKMessage);
    sdk.pushMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-1',
      tool_use_id: 'tool-agent-1',
      description: 'Research',
      uuid: 'started-1',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    assert.strictEqual(runtime.isSubagentRunning('tool-agent-1'), true);
    assert.strictEqual(runtime.isSubagentRunning('tool-unrelated'), false);

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
      uuid: 'snapshot-2',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    assert.strictEqual(runtime.isSubagentRunning('tool-agent-1'), false);
  });

  it('restores foreground activity when the main agent resumes after background work', async () => {
    const events: SseEvent[] = [];
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      (_id, event) => events.push(event),
    );
    runtime.pushMessage('start');

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'agent-1', task_type: 'agent', description: 'Research' }],
      uuid: 'snapshot-1',
      session_id: 's1',
    } as SDKMessage);
    await tick();
    sdk.pushMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'waiting for background work',
      parent_tool_use_id: null,
    } as SDKMessage);
    await tick();

    sdk.pushMessage({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'background-agent-message' },
      },
      parent_tool_use_id: 'agent-tool-use',
      uuid: 'background-agent',
      session_id: 's1',
    } as unknown as SDKMessage);
    await tick();
    assert.deepStrictEqual(
      runtime.getActivitySnapshot(),
      {
        phase: 'background',
        active: true,
        backgroundTasks: [{ id: 'agent-1', type: 'agent', description: 'Research' }],
      },
    );

    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
      uuid: 'snapshot-2',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    sdk.pushMessage({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'resumed-main-agent-message' },
      },
      parent_tool_use_id: null,
      uuid: 'resumed-main-agent',
      session_id: 's1',
    } as unknown as SDKMessage);
    await tick();

    assert.deepStrictEqual(activityEvents(events).at(-1), {
      type: 'session_activity',
      phase: 'foreground',
      active: true,
      backgroundTasks: [],
    });
  });

  it('forces the current activity snapshot after WebSocket replay', async () => {
    const events: SseEvent[] = [];
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      (_id, event) => events.push(event),
    );
    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'agent', description: 'Inspect tests' }],
      uuid: 'snapshot-1',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    const ringBuffer = (runtime as unknown as RuntimeInternals).ringBuffer;
    const firstId = ringBuffer[0].id;
    ringBuffer.push({
      id: 'stale-activity',
      event: {
        type: 'session_activity',
        phase: 'idle',
        active: false,
        backgroundTasks: [],
      } as unknown as SseEvent,
    });
    const replayed: SseEvent[] = [];
    runtime.subscribeWebSocket((_id, event) => replayed.push(event), firstId);

    assert.deepStrictEqual(activityEvents(replayed).at(-1), {
      type: 'session_activity',
      phase: 'background',
      active: true,
      backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Inspect tests' }],
    });
  });

  it('publishes one inactive interrupted snapshot when the SDK loop fails with active work', async () => {
    const events: SseEvent[] = [];
    const sdk = createActivitySdkClient();
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      (_id, event) => events.push(event),
    );
    runtime.pushMessage('start');
    sdk.pushMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'agent', description: 'Long task' }],
      uuid: 'snapshot-1',
      session_id: 's1',
    } as SDKMessage);
    await tick();

    sdk.failLoop(new Error('stream died'));
    await tick();

    assert.deepStrictEqual(activityEvents(events).at(-1), {
      type: 'session_activity',
      phase: 'idle',
      active: false,
      backgroundTasks: [],
      interruption: {
        reason: 'runtime_failure',
        message: 'stream died',
        foregroundInterrupted: true,
        backgroundTasks: [{ id: 'bg-1', type: 'agent', description: 'Long task' }],
      },
    });
    assert.strictEqual(
      activityEvents(events).filter((event) => event.interruption !== undefined).length,
      1,
    );
  });
});

describe('session-runtime fenced stop', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) await runtime.close();
    runtime = undefined;
  });

  function createStopSdk(options: {
    interrupt?: () => Promise<{ still_queued: string[] } | undefined>;
    stopTask?: (taskId: string) => Promise<void>;
  } = {}) {
    const calls = { interrupt: 0, stopTask: [] as string[], close: 0 };
    let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined;
    const queued: SDKMessage[] = [];
    const messages = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        const message = queued.shift();
        if (message) return { value: message, done: false };
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncGenerator<SDKMessage>;
    const query = {
      interrupt: async () => {
        calls.interrupt++;
        if (calls.interrupt > 1) return { still_queued: [] };
        return (options.interrupt ?? (async () => ({ still_queued: [] })))();
      },
      stopTask: async (taskId: string) => {
        calls.stopTask.push(taskId);
        return (options.stopTask ?? (async () => {}))(taskId);
      },
      close: () => {
        calls.close++;
        const resolve = waiting;
        waiting = undefined;
        resolve?.({ value: undefined, done: true });
      },
      getContextUsage: () => Promise.resolve({
        totalTokens: 0,
        maxTokens: 1,
        percentage: 0,
        categories: [],
      }),
    } as unknown as Query;
    return {
      calls,
      client: {
        createStreamingQuery: () => ({ query, messages }),
      } as unknown as SdkClient,
      push: (message: SDKMessage) => {
        const resolve = waiting;
        waiting = undefined;
        if (resolve) resolve({ value: message, done: false });
        else queued.push(message);
      },
      finish: () => {
        const resolve = waiting;
        waiting = undefined;
        resolve?.({ value: undefined, done: true });
      },
    };
  }

  function snapshot(tasks: Array<{ id: string; type?: string; description?: string }>): SDKMessage {
    return {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: tasks.map((task) => ({
        task_id: task.id,
        task_type: task.type ?? 'agent',
        description: task.description ?? task.id,
      })),
      uuid: randomTestUuid(),
      session_id: 's1',
    } as SDKMessage;
  }

  function randomTestUuid(): string {
    return `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('enters stopping and interrupts immediately before the first SDK event', async () => {
    let resolveInterrupt!: (receipt: { still_queued: string[] }) => void;
    const sdk = createStopSdk({
      interrupt: () => new Promise((resolve) => {
        resolveInterrupt = resolve;
      }),
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('queued work');

    const stopping = runtime.stopAll();

    assert.deepStrictEqual(runtime.getActivitySnapshot(), {
      phase: 'stopping',
      active: true,
      backgroundTasks: [],
    });
    assert.strictEqual(sdk.calls.interrupt, 1);
    assert.throws(() => runtime!.pushMessage('must not queue'), /stopping/i);

    resolveInterrupt({ still_queued: [] });
    await stopping;
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
    assert.strictEqual(sdk.calls.close, 0);
  });

  it('hard-closes immediately when interrupt cannot prove the queue is empty', async () => {
    const sdk = createStopSdk({ interrupt: async () => undefined });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('queued work');

    await runtime.stopAll();

    assert.strictEqual(sdk.calls.interrupt, 1);
    assert.strictEqual(sdk.calls.close, 1);
    assert.strictEqual(runtime.isClosed(), true);
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
  });

  it('hard-closes immediately when interrupt reports queued work', async () => {
    const sdk = createStopSdk({ interrupt: async () => ({ still_queued: ['queued-message'] }) });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('queued work');

    await runtime.stopAll();

    assert.strictEqual(sdk.calls.close, 1);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /1 queued message/);
  });

  it('hard-closes immediately when interrupt rejects', async () => {
    const sdk = createStopSdk({ interrupt: async () => { throw new Error('control failed'); } });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('queued work');

    await runtime.stopAll();

    assert.strictEqual(sdk.calls.close, 1);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /control failed/);
  });

  it('records background-only Stop without claiming a foreground interruption', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    const stopping = runtime.stopAll();
    await tick();
    sdk.push(snapshot([]));
    await stopping;

    assert.strictEqual(runtime.getActivitySnapshot().interruption?.foregroundInterrupted, false);
  });

  it('stops one tracked background task without fencing the Session', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }, { id: 'b' }]));
    await tick();

    const stopped = await runtime.stopBackgroundTask('a');

    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(sdk.calls.stopTask, ['a']);
    assert.strictEqual(sdk.calls.interrupt, 0);
    assert.strictEqual(sdk.calls.close, 0);
    assert.deepStrictEqual(runtime.getActivitySnapshot(), {
      phase: 'background',
      active: true,
      backgroundTasks: [
        { id: 'a', type: 'agent', description: 'a' },
        { id: 'b', type: 'agent', description: 'b' },
      ],
    });
  });

  it('treats an unknown background task as an idempotent no-op', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);

    const stopped = await runtime.stopBackgroundTask('missing');

    assert.strictEqual(stopped, false);
    assert.deepStrictEqual(sdk.calls.stopTask, []);
  });

  it('deduplicates repeated task stops until the SDK removes the task', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    await runtime.stopBackgroundTask('a');
    await runtime.stopBackgroundTask('a');

    assert.deepStrictEqual(sdk.calls.stopTask, ['a']);

    sdk.push(snapshot([]));
    await tick();
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();
    await runtime.stopBackgroundTask('a');

    assert.deepStrictEqual(sdk.calls.stopTask, ['a', 'a']);
  });

  it('allows an individual task stop to be retried after the SDK rejects it', async () => {
    let attempts = 0;
    const sdk = createStopSdk({
      stopTask: async () => {
        attempts++;
        if (attempts === 1) throw new Error('temporary stop failure');
      },
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    await assert.rejects(runtime.stopBackgroundTask('a'), /temporary stop failure/);
    assert.strictEqual(await runtime.stopBackgroundTask('a'), true);

    assert.deepStrictEqual(sdk.calls.stopTask, ['a', 'a']);
    assert.strictEqual(sdk.calls.interrupt, 0);
  });

  it('treats a task removed by an SDK snapshot during stop as already finished', async () => {
    let rejectTaskStop!: (error: Error) => void;
    const sdk = createStopSdk({
      stopTask: () => new Promise<void>((_resolve, reject) => {
        rejectTaskStop = reject;
      }),
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    const stopping = runtime.stopBackgroundTask('a');
    sdk.push(snapshot([]));
    await tick();
    rejectTaskStop(new Error('task already completed'));

    assert.strictEqual(await stopping, false);
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
  });

  it('times out a stuck individual stop and allows retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const sdk = createStopSdk({
      stopTask: () => {
        attempts++;
        return attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const firstStop = runtime.stopBackgroundTask('a');
    t.mock.timers.tick(10_000);
    await assert.rejects(firstStop, /Timed out stopping background task a/);
    assert.strictEqual(await runtime.stopBackgroundTask('a'), true);

    assert.deepStrictEqual(sdk.calls.stopTask, ['a', 'a']);
  });

  it('joins an in-flight individual stop when the whole Session is stopped', async () => {
    let resolveTaskStop!: () => void;
    const sdk = createStopSdk({
      stopTask: () => new Promise<void>((resolve) => {
        resolveTaskStop = resolve;
      }),
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    const individualStop = runtime.stopBackgroundTask('a');
    const sessionStop = runtime.stopAll();
    await tick();

    assert.deepStrictEqual(sdk.calls.stopTask, ['a']);
    resolveTaskStop();
    sdk.push(snapshot([]));
    await Promise.all([individualStop, sessionStop]);

    assert.strictEqual(sdk.calls.close, 0);
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
  });

  it('hard-closes when an in-flight individual stop fails during whole-Session Stop', async () => {
    let rejectTaskStop!: (error: Error) => void;
    const sdk = createStopSdk({
      stopTask: () => new Promise<void>((_resolve, reject) => {
        rejectTaskStop = reject;
      }),
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    const individualStop = runtime.stopBackgroundTask('a');
    const sessionStop = runtime.stopAll();
    await tick();
    rejectTaskStop(new Error('control request failed'));

    await assert.rejects(individualStop, /control request failed/);
    await sessionStop;
    assert.strictEqual(sdk.calls.close, 1);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /control request failed/);
  });

  it('rejects individual task stopping for a non-Claude driver', async () => {
    const sdk = createStopSdk();
    const driver = {
      backendId: 'opencode' as const,
      createStreamingQuery: () => sdk.client.createStreamingQuery({} as never, {} as Options),
    };
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdk.client,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      driver,
    );

    await assert.rejects(
      runtime.stopBackgroundTask('task-1'),
      /only supported for Claude Code sessions/,
    );
    assert.deepStrictEqual(sdk.calls.stopTask, []);
  });

  it('hard-closes at the original two-second Stop deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stopping = runtime.stopAll();
    await Promise.resolve();
    t.mock.timers.tick(2000);
    await stopping;

    assert.strictEqual(sdk.calls.close, 1);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /deadline expired/);
  });

  it('stops existing and late tasks once until an empty snapshot settles the fence', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('work');
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    const stopping = runtime.stopAll();
    await tick();
    assert.deepStrictEqual(sdk.calls.stopTask, ['a']);

    sdk.push(snapshot([{ id: 'a' }, { id: 'b' }]));
    await tick();
    assert.deepStrictEqual(sdk.calls.stopTask, ['a', 'b']);

    sdk.push(snapshot([{ id: 'b' }]));
    await tick();
    assert.deepStrictEqual(sdk.calls.stopTask, ['a', 'b']);
    sdk.push(snapshot([]));
    await stopping;

    assert.strictEqual(sdk.calls.close, 0);
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
  });

  it('hard-closes when stopping any task fails', async () => {
    const sdk = createStopSdk({
      stopTask: async () => {
        throw new Error('stop failed');
      },
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    sdk.push(snapshot([{ id: 'a' }]));
    await tick();

    await runtime.stopAll();

    assert.deepStrictEqual(sdk.calls.stopTask, ['a']);
    assert.strictEqual(sdk.calls.close, 1);
    assert.strictEqual(runtime.isClosed(), true);
  });

  it('repeated Stop calls join one fenced operation', async () => {
    let resolveInterrupt!: (receipt: { still_queued: string[] }) => void;
    const sdk = createStopSdk({
      interrupt: () => new Promise((resolve) => {
        resolveInterrupt = resolve;
      }),
    });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('work');

    const first = runtime.stopAll();
    const second = runtime.stopAll();
    assert.strictEqual(first, second);
    assert.strictEqual(sdk.calls.interrupt, 1);

    resolveInterrupt({ still_queued: [] });
    await Promise.all([first, second]);
  });

  it('hard-closes and settles Stop when the SDK message stream ends during the drain', async () => {
    const sdk = createStopSdk({ interrupt: () => new Promise(() => {}) });
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('work');

    const stopping = runtime.stopAll();
    sdk.finish();
    await stopping;

    assert.strictEqual(sdk.calls.close, 1);
    assert.strictEqual(runtime.isClosed(), true);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /stream ended during Stop/);
  });

  it('hard-closes background work that appears after graceful Stop completes', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('work');
    await runtime.stopAll();

    sdk.push(snapshot([{ id: 'late' }]));
    await tick();

    assert.deepStrictEqual(sdk.calls.stopTask, ['late']);
    assert.strictEqual(sdk.calls.close, 1);
    assert.strictEqual(runtime.isClosed(), true);
    assert.match(runtime.getActivitySnapshot().interruption?.message ?? '', /new background work/);
  });

  it('denies interaction requests that arrive after graceful Stop completes', async () => {
    const sdk = createStopSdk();
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, sdk.client);
    runtime.pushMessage('work');
    await runtime.stopAll();

    const result = await runtime.requestToolApproval('late-approval', 'Bash', 'tool-1', {});

    assert.deepStrictEqual(result, { behavior: 'deny', message: 'Session stopped by user.' });
    assert.strictEqual(runtime.getActivitySnapshot().active, false);
  });
});

describe('session-runtime backend driver seam (KTD-1)', { concurrency: false }, () => {
  it('starts the query through the injected driver, not the sdkClient', () => {
    let driverCalls = 0;
    let sdkCalls = 0;
    const messages = (async function* () {})();
    const driver = {
      backendId: 'claude' as const,
      createStreamingQuery: () => {
        driverCalls += 1;
        return {
          query: { interrupt: () => Promise.resolve(), close: () => {} },
          messages,
        };
      },
    };
    const sdkClient = {
      createStreamingQuery: () => {
        sdkCalls += 1;
        throw new Error('sdkClient must not be called when a driver is injected');
      },
    } as unknown as SdkClient;

    const runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      sdkClient,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      driver as never,
    );
    assert.strictEqual(driverCalls, 1);
    assert.strictEqual(sdkCalls, 0);
    void runtime;
  });
});

describe('session-runtime pending approval fresh-subscription replay (U6, KTD-23)', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;
    const messageGen = (async function* () {})();
    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: messageGen,
      }),
    } as unknown as SdkClient;
  }

  /** A mock SSE response that parses written frames back into events. */
  function createCapturingResponse(): { res: import('express').Response; events: SseEvent[] } {
    const events: SseEvent[] = [];
    const res = {
      write: (chunk: unknown) => {
        const dataLine = String(chunk)
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (dataLine) {
          try {
            events.push(JSON.parse(dataLine.slice('data: '.length)) as SseEvent);
          } catch {
            // heartbeat frames carry no JSON payload
          }
        }
        return true;
      },
    } as unknown as import('express').Response;
    return { res, events };
  }

  it('re-emits pending_approval state to a fresh subscriber (reconnect without lastEventId)', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const approvalPromise = runtime.requestToolApproval(
      'req-1',
      'Bash',
      'toolu-1',
      { command: 'curl https://example.com' },
      { timeout: 60_000 },
    );

    // Fresh subscription AFTER the approval was requested — the original
    // pending_approval event was never seen by this client.
    const { res, events } = createCapturingResponse();
    runtime.subscribe(res);

    const pending = events.filter(
      (event) => (event as { type: string }).type === 'pending_approval',
    ) as unknown as Array<Record<string, unknown>>;
    assert.strictEqual(pending.length, 1, 'exactly one pending_approval replay');
    assert.strictEqual(pending[0].requestId, 'req-1');
    assert.strictEqual(pending[0].toolName, 'Bash');
    assert.strictEqual(pending[0].toolUseId, 'toolu-1');
    assert.deepStrictEqual(pending[0].input, { command: 'curl https://example.com' });
    assert.strictEqual(typeof pending[0].expiresAt, 'number', 'TTL rides the replay');

    runtime.resolveApproval('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'curl https://example.com' },
    });
    await approvalPromise;
  });

  it('does not re-emit approvals that resolved before the subscription', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const approvalPromise = runtime.requestToolApproval('req-2', 'Bash', 'toolu-2', { command: 'ls' });
    runtime.resolveApproval('req-2', { behavior: 'allow', updatedInput: { command: 'ls' } });
    await approvalPromise;

    const { res, events } = createCapturingResponse();
    runtime.subscribe(res);
    const pending = events.filter((event) => (event as { type: string }).type === 'pending_approval');
    assert.strictEqual(pending.length, 0, 'resolved approvals must not replay as pending');
  });

  it('re-emits pending_question state on the same machinery', async () => {
    runtime = SessionRuntime.open('s1', 'ws1', 'nonce', {} as Options, createMockSdkClient());
    const questionPromise = runtime.requestToolQuestion(
      'req-3',
      [{ question: 'Proceed?', options: [{ label: 'Yes' }], multiSelect: false }],
      {},
    );

    const { res, events } = createCapturingResponse();
    runtime.subscribe(res);
    const pending = events.filter(
      (event) => (event as { type: string }).type === 'pending_question',
    ) as unknown as Array<Record<string, unknown>>;
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].requestId, 'req-3');

    runtime.resolveApproval('req-3', { behavior: 'allow', updatedInput: {} });
    await questionPromise;
  });
});
