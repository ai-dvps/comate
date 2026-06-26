import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionRuntime } from './session-runtime.js';
import type { SdkClient } from './sdk-client.js';
import type { Query, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent } from '../types/message.js';

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