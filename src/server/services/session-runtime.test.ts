import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionRuntime } from './session-runtime.js';
import type { SdkClient } from './sdk-client.js';
import type { Query, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { SseEvent, TaskSignal } from '../types/message.js';
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

// Shared scaffolding for the background-task tracker describes below.
// Private-state casts go through this structural type.
type TrackerRuntime = {
  handleTaskSignal: (signal: TaskSignal) => void;
  evaluateProcessingEdge: () => void;
  currentMessageStartId?: string;
  confirmedBackgroundTasks: Set<string>;
  ringBuffer: Array<{ id: string; event: SseEvent }>;
};

function signal(rt: SessionRuntime, sig: TaskSignal): void {
  (rt as unknown as TrackerRuntime).handleTaskSignal(sig);
}

function processingEvents(events: SseEvent[]) {
  return events.filter(
    (e): e is Extract<SseEvent, { type: 'session_processing' }> => e.type === 'session_processing',
  );
}

function createEmptyMockSdkClient(): SdkClient {
  const mockQuery = {
    interrupt: () => Promise.resolve(),
    close: () => {},
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

describe('session-runtime background task tracking', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function openRuntime(events: SseEvent[]): SessionRuntime {
    return SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createEmptyMockSdkClient(),
      (_id, event) => events.push(event),
    );
  }

  function edge(rt: SessionRuntime): void {
    (rt as unknown as TrackerRuntime).evaluateProcessingEdge();
  }

  it('stays processing after the turn result while a confirmed background task runs (F1)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu1' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'confirmed task extends processing');
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
      'the {true} edge fires once, at confirmation',
    );

    // The foreground turn starts and ends around the running task.
    const tracker = runtime as unknown as TrackerRuntime;
    tracker.currentMessageStartId = 'msg-1';
    edge(runtime);
    tracker.currentMessageStartId = undefined;
    edge(runtime);
    assert.strictEqual(runtime.isProcessingTurn(), true, 'task outlives the turn result');
    assert.strictEqual(processingEvents(events).length, 1, 'no edge while the task outlives the turn');

    signal(runtime, { kind: 'terminal', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.deepStrictEqual(
      processingEvents(events),
      [
        { type: 'session_processing', processing: true, backgroundTaskCount: 1 },
        { type: 'session_processing', processing: false, backgroundTaskCount: 0 },
      ],
      'a single {false} edge fires when the task settles',
    );
  });

  it('stays active until the last of two confirmed tasks settles (AE4)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });
    signal(runtime, { kind: 'started', taskId: 't2', toolUseId: 'tu2' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu1' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu2' });
    assert.strictEqual(runtime.isProcessingTurn(), true);
    assert.strictEqual(processingEvents(events).length, 1, 'only the first confirmation flips the predicate');

    signal(runtime, { kind: 'terminal', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'first settle keeps the session active');
    assert.strictEqual(
      processingEvents(events).filter((e) => e.processing === false).length,
      0,
      'no {false} edge after the first settle',
    );

    signal(runtime, { kind: 'terminal', taskId: 't2' });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    const falseEdges = processingEvents(events).filter((e) => e.processing === false);
    assert.deepStrictEqual(
      falseEdges,
      [{ type: 'session_processing', processing: false, backgroundTaskCount: 0 }],
      'exactly one {false} edge, after the second terminal',
    );
  });

  it('confirms a candidate via an is_backgrounded task patch (R2 path c)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), false, 'bare candidate has no predicate effect');

    signal(runtime, { kind: 'backgroundedPatch', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), true);
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
    );

    // Predicate extends past the turn end.
    const tracker = runtime as unknown as TrackerRuntime;
    tracker.currentMessageStartId = 'msg-1';
    edge(runtime);
    tracker.currentMessageStartId = undefined;
    edge(runtime);
    assert.strictEqual(runtime.isProcessingTurn(), true);
    assert.strictEqual(processingEvents(events).length, 1);
  });

  it('confirms directly from a Bash backgroundTaskId result with no prior candidate (R2 path b)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'bashBackgrounded', toolUseId: 'tu9', taskId: 'b1' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'the Bash result is itself the confirmed signal');
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
    );
  });

  it('discards late confirmations for terminated tasks (ghost guard)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });
    signal(runtime, { kind: 'terminal', taskId: 't1' });

    signal(runtime, { kind: 'backgroundedPatch', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), false, 'tombstoned task must not resurrect');

    signal(runtime, { kind: 'bashBackgrounded', toolUseId: 'tu1', taskId: 't1' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu1' });
    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });

    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, 0, 'no edges from ghost confirmations');
    assert.strictEqual(
      (runtime as unknown as TrackerRuntime).confirmedBackgroundTasks.size,
      0,
    );
  });

  it('confirms via pending confirmation when asyncLaunched arrives before task_started', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu1' });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, 0, 'no confirmation without a candidate');

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'pending confirmation consumed by task_started');
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
    );
  });

  it('single-candidate fallback confirms an uncorrelated asyncLaunched', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu-uncorrelated' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'sole candidate without toolUseId is confirmed');
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
    );
  });

  it('does not guess when two candidates await an uncorrelated asyncLaunched', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1' });
    signal(runtime, { kind: 'started', taskId: 't2' });
    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu-uncorrelated' });
    assert.strictEqual(runtime.isProcessingTurn(), false, 'no fallback with two candidates');
    assert.strictEqual(processingEvents(events).length, 0);
  });

  it('never tracks skip_transcript tasks (AE3)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, {
      kind: 'started',
      taskId: 't1',
      toolUseId: 'tu1',
      skipTranscript: true,
      subagentType: 'general-purpose',
    });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, 0, 'no edges from ambient tasks');

    signal(runtime, { kind: 'asyncLaunched', toolUseId: 'tu1' });
    assert.strictEqual(runtime.isProcessingTurn(), false, 'no candidate exists to confirm');
    assert.strictEqual(processingEvents(events).length, 0);
  });

  it('idles at the turn result when a candidate was never confirmed (AE2)', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    const tracker = runtime as unknown as TrackerRuntime;
    tracker.currentMessageStartId = 'msg-1';
    edge(runtime);
    assert.deepStrictEqual(
      processingEvents(events),
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 0 }],
    );

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });

    tracker.currentMessageStartId = undefined;
    edge(runtime);
    assert.strictEqual(runtime.isProcessingTurn(), false, 'unconfirmed candidate lets the session idle');
    assert.deepStrictEqual(
      processingEvents(events),
      [
        { type: 'session_processing', processing: true, backgroundTaskCount: 0 },
        { type: 'session_processing', processing: false, backgroundTaskCount: 0 },
      ],
    );
  });

  it('an unconfirmed candidate that never terminates has no predicate effect', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'started', taskId: 't1', toolUseId: 'tu1' });
    edge(runtime);
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, 0);
  });

  it('treats a terminal signal for a never-seen task as a no-op', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'terminal', taskId: 'ghost' });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, 0);
  });

  it('isTurnActive reflects only the turn marker and pending approvals', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    assert.strictEqual(runtime.isTurnActive(), false);
    assert.strictEqual(runtime.isProcessingTurn(), false);

    signal(runtime, { kind: 'backgroundedPatch', taskId: 'bg-1' });
    assert.strictEqual(runtime.isProcessingTurn(), true, 'background tasks extend processing');
    assert.strictEqual(runtime.isTurnActive(), false, 'background tasks do not count as an active turn');

    const tracker = runtime as unknown as TrackerRuntime;
    tracker.currentMessageStartId = 'msg-1';
    assert.strictEqual(runtime.isTurnActive(), true);
    tracker.currentMessageStartId = undefined;

    const pendingApprovals = (runtime as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals;
    pendingApprovals.set('req-1', { resolve: () => {}, input: {}, type: 'approval' });
    assert.strictEqual(runtime.isTurnActive(), true);
  });

  it('logs every started signal with toolUseId, subagentType, and skipTranscript', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    const { logs, restore } = collectDiagLogs();
    try {
      signal(runtime, {
        kind: 'started',
        taskId: 't-obs',
        toolUseId: 'tu-obs',
        subagentType: 'Explore',
        skipTranscript: false,
      });
    } finally {
      restore();
    }

    const line = logs.find((l) => l.includes('task_started') && l.includes('t-obs'));
    assert.ok(line, 'expected a task_started observation line');
    assert.ok(line!.includes('tu-obs'), 'line should carry the toolUseId');
    assert.ok(line!.includes('Explore'), 'line should carry the subagentType');
    assert.ok(line!.includes('skipTranscript'), 'line should carry the skipTranscript flag');
  });

  it('subscribe force-emits the current verdict during background-only processing', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'backgroundedPatch', taskId: 'bg-1' });
    assert.strictEqual(runtime.isProcessingTurn(), true);
    events.length = 0;

    runtime.subscribe(createMockResponse());

    const emitted = processingEvents(events);
    assert.deepStrictEqual(
      emitted,
      [{ type: 'session_processing', processing: true, backgroundTaskCount: 1 }],
      'fresh subscriber mid background-only task gets the current verdict',
    );
  });

  it('subscribeWebSocket replays first and force-emits last so the current verdict wins', () => {
    const events: SseEvent[] = [];
    runtime = openRuntime(events);

    signal(runtime, { kind: 'backgroundedPatch', taskId: 'bg-1' });
    assert.strictEqual(runtime.isProcessingTurn(), true);

    // Plant a stale verdict at the end of the ring buffer so replay alone
    // would deliver the wrong state.
    const ringBuffer = (runtime as unknown as TrackerRuntime).ringBuffer;
    const firstId = ringBuffer[0].id;
    ringBuffer.push({
      id: 'stale-1',
      event: { type: 'session_processing', processing: false, backgroundTaskCount: 0 },
    });

    const replayed: SseEvent[] = [];
    runtime.subscribeWebSocket((_id, event) => replayed.push(event), firstId);

    const sp = processingEvents(replayed);
    assert.ok(sp.length >= 2, 'expected the replayed stale verdict and the force-emitted verdict');
    assert.deepStrictEqual(
      sp[sp.length - 1],
      { type: 'session_processing', processing: true, backgroundTaskCount: 1 },
      'force-emit lands after replay, so the current verdict wins',
    );
    const staleIndex = replayed.lastIndexOf(
      sp.find((e) => e.processing === false)!,
    );
    const trueIndex = replayed.lastIndexOf(sp[sp.length - 1]);
    assert.ok(trueIndex > staleIndex, 'force-emit must come after the replayed stale event');
  });
});

describe('session-runtime marker-clear race', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;
  let finishLoop: (() => void) | undefined;

  afterEach(async () => {
    finishLoop?.();
    finishLoop = undefined;
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createControllableSdkClient(): {
    client: SdkClient;
    push: (msg: SDKMessage | null) => void;
  } {
    const queue: Array<SDKMessage | null> = [];
    let resolveNext: ((msg: SDKMessage | null) => void) | null = null;
    const messageGen = (async function* () {
      while (true) {
        let msg: SDKMessage | null;
        if (queue.length > 0) {
          msg = queue.shift()!;
        } else {
          msg = await new Promise<SDKMessage | null>((r) => {
            resolveNext = r;
          });
        }
        if (msg === null) break;
        yield msg;
      }
    })();
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
      getContextUsage: () =>
        Promise.resolve({
          totalTokens: 0,
          maxTokens: 1,
          percentage: 0,
          categories: [],
        }),
    } as unknown as Query;
    return {
      client: {
        createStreamingQuery: () => ({ query: mockQuery, messages: messageGen }),
      } as unknown as SdkClient,
      push: (msg) => {
        if (resolveNext) {
          resolveNext(msg);
          resolveNext = null;
        } else {
          queue.push(msg);
        }
      },
    };
  }

  const tick = () => new Promise((r) => setTimeout(r, 30));

  it('a real result message does not idle the session while a background task runs', async () => {
    const events: SseEvent[] = [];
    const { client, push } = createControllableSdkClient();
    finishLoop = () => push(null);
    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      client,
      (_id, event) => events.push(event),
    );

    // Foreground turn starts: assistant_start sets the turn marker.
    push({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    await tick();
    assert.strictEqual(runtime.isProcessingTurn(), true, 'turn marker set');
    const sp = () =>
      events.filter(
        (e): e is Extract<SseEvent, { type: 'session_processing' }> => e.type === 'session_processing',
      );
    assert.deepStrictEqual(sp(), [
      { type: 'session_processing', processing: true, backgroundTaskCount: 0 },
    ]);

    // A background task is confirmed mid-turn.
    (runtime as unknown as TrackerRuntime).handleTaskSignal({
      kind: 'backgroundedPatch',
      taskId: 'bg-1',
    });
    assert.strictEqual(sp().length, 1, 'no flip while the turn is already processing');

    // The turn's result arrives and clears the marker — the original bug
    // would idle the session here.
    push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    await tick();
    assert.strictEqual(
      runtime.isProcessingTurn(),
      true,
      'result must not idle the session while a background task runs',
    );
    assert.ok(
      !sp().some((e) => e.processing === false),
      'no {false} edge on the marker clear',
    );

    // When the task settles, the session idles.
    (runtime as unknown as TrackerRuntime).handleTaskSignal({
      kind: 'terminal',
      taskId: 'bg-1',
    });
    assert.deepStrictEqual(sp()[sp().length - 1], {
      type: 'session_processing',
      processing: false,
      backgroundTaskCount: 0,
    });
  });
});

describe('session-runtime stopAll (clear-all)', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  type QueryCalls = { interrupt: number; stopTask: string[] };

  function createMockSdkClient(handlers: {
    interrupt?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
  } = {}): { client: SdkClient; calls: QueryCalls } {
    const calls: QueryCalls = { interrupt: 0, stopTask: [] };
    const mockQuery = {
      interrupt: () => {
        calls.interrupt++;
        return (handlers.interrupt ?? (() => Promise.resolve()))();
      },
      stopTask: (taskId: string) => {
        calls.stopTask.push(taskId);
        return (handlers.stopTask ?? (() => Promise.resolve()))(taskId);
      },
      close: () => {},
    } as unknown as Query;

    return {
      calls,
      client: {
        createStreamingQuery: () => ({
          query: mockQuery,
          messages: (async function* () {})(),
        }),
      } as unknown as SdkClient,
    };
  }

  function openRuntime(events: SseEvent[], client: SdkClient): SessionRuntime {
    return SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      client,
      (_id, event) => events.push(event),
    );
  }

  function confirmTask(rt: SessionRuntime, taskId: string, toolUseId: string): void {
    signal(rt, { kind: 'started', taskId, toolUseId });
    signal(rt, { kind: 'asyncLaunched', toolUseId });
  }

  it('interrupts the turn and stops every confirmed task in one call (F2)', async () => {
    const events: SseEvent[] = [];
    const { client, calls } = createMockSdkClient();
    runtime = openRuntime(events, client);
    const tracker = runtime as unknown as TrackerRuntime;

    confirmTask(runtime, 't1', 'tu1');
    confirmTask(runtime, 't2', 'tu2');
    tracker.currentMessageStartId = 'msg-1';
    tracker.evaluateProcessingEdge();
    assert.strictEqual(runtime.isProcessingTurn(), true);

    await runtime.stopAll();

    assert.strictEqual(calls.interrupt, 1, 'interrupt invoked exactly once');
    assert.deepStrictEqual(calls.stopTask.sort(), ['t1', 't2'], 'stopTask per confirmed task');
    assert.strictEqual(tracker.confirmedBackgroundTasks.size, 0, 'tasks untracked on resolve');

    // The interrupted turn ends: the emitter clears the marker on the
    // `interrupted` event. Simulate that and expect exactly one {false} edge.
    tracker.currentMessageStartId = undefined;
    tracker.evaluateProcessingEdge();
    assert.strictEqual(runtime.isProcessingTurn(), false);
    const falseEdges = processingEvents(events).filter((e) => e.processing === false);
    assert.deepStrictEqual(
      falseEdges,
      [{ type: 'session_processing', processing: false, backgroundTaskCount: 0 }],
      'exactly one final {false} edge',
    );
  });

  it('stops confirmed tasks without interrupting when no turn is in flight', async () => {
    const events: SseEvent[] = [];
    const { client, calls } = createMockSdkClient();
    runtime = openRuntime(events, client);

    confirmTask(runtime, 't1', 'tu1');
    confirmTask(runtime, 't2', 'tu2');
    assert.strictEqual(runtime.isTurnActive(), false, 'background tasks alone are not a turn');

    await runtime.stopAll();

    assert.strictEqual(calls.interrupt, 0, 'no turn → no interrupt');
    assert.deepStrictEqual(calls.stopTask.sort(), ['t1', 't2']);
    assert.strictEqual(runtime.isProcessingTurn(), false);
    const falseEdges = processingEvents(events).filter((e) => e.processing === false);
    assert.deepStrictEqual(
      falseEdges,
      [{ type: 'session_processing', processing: false, backgroundTaskCount: 0 }],
      '{false} fires once, after the last untrack',
    );
  });

  it('is idempotent with the terminal stopped notification (R9 safety net)', async () => {
    const events: SseEvent[] = [];
    const { client } = createMockSdkClient();
    runtime = openRuntime(events, client);

    confirmTask(runtime, 't1', 'tu1');
    await runtime.stopAll();
    assert.strictEqual(runtime.isProcessingTurn(), false);
    const edgesAfterStop = processingEvents(events).length;

    // The SDK's terminal `stopped` notification arrives after the optimistic
    // untrack: no resurrection, no extra edge.
    signal(runtime, { kind: 'terminal', taskId: 't1' });
    assert.strictEqual(runtime.isProcessingTurn(), false);
    assert.strictEqual(processingEvents(events).length, edgesAfterStop, 'no extra edge');
    assert.strictEqual(
      (runtime as unknown as TrackerRuntime).confirmedBackgroundTasks.size,
      0,
    );
  });

  it('does not stop a task confirmed after the snapshot', async () => {
    const events: SseEvent[] = [];
    const holder: { rt?: SessionRuntime } = {};
    const { client, calls } = createMockSdkClient({
      stopTask: async () => {
        // A new background task is confirmed while stopAll iterates.
        if (holder.rt) confirmTask(holder.rt, 't3', 'tu3');
      },
    });
    runtime = openRuntime(events, client);
    holder.rt = runtime;

    confirmTask(runtime, 't1', 'tu1');
    await runtime.stopAll();

    assert.deepStrictEqual(calls.stopTask, ['t1'], 'only the snapshot task is stopped');
    assert.strictEqual(
      (runtime as unknown as TrackerRuntime).confirmedBackgroundTasks.has('t3'),
      true,
      'the late task stays tracked',
    );
    assert.strictEqual(runtime.isProcessingTurn(), true);
  });

  it('still stops tasks when interrupt throws, logging the failure', async () => {
    const { logs, restore } = collectDiagLogs();
    const events: SseEvent[] = [];
    const { client, calls } = createMockSdkClient({
      interrupt: () => Promise.reject(new Error('boom')),
    });
    try {
      runtime = openRuntime(events, client);
      const tracker = runtime as unknown as TrackerRuntime;
      confirmTask(runtime, 't1', 'tu1');
      tracker.currentMessageStartId = 'msg-1';

      await runtime.stopAll(); // must not throw

      assert.strictEqual(calls.interrupt, 1);
      assert.deepStrictEqual(calls.stopTask, ['t1'], 'the task loop still runs');
      assert.ok(
        logs.some((line) => line.includes('stopAll') && line.includes('boom')),
        'interrupt failure is logged',
      );
    } finally {
      restore();
    }
  });

  it('keeps other stops and leaves the task tracked when one stopTask rejects', async () => {
    const { logs, restore } = collectDiagLogs();
    const events: SseEvent[] = [];
    const { client, calls } = createMockSdkClient({
      stopTask: (taskId) =>
        taskId === 't2' ? Promise.reject(new Error('stop failed')) : Promise.resolve(),
    });
    try {
      runtime = openRuntime(events, client);
      const tracker = runtime as unknown as TrackerRuntime;
      confirmTask(runtime, 't1', 'tu1');
      confirmTask(runtime, 't2', 'tu2');

      await runtime.stopAll(); // must not throw

      assert.deepStrictEqual(calls.stopTask.sort(), ['t1', 't2'], 'both stops attempted');
      assert.strictEqual(tracker.confirmedBackgroundTasks.has('t1'), false);
      assert.strictEqual(
        tracker.confirmedBackgroundTasks.has('t2'),
        true,
        'the rejected task stays tracked',
      );
      assert.strictEqual(runtime.isProcessingTurn(), true, 'predicate may stay true');
      assert.ok(
        logs.some((line) => line.includes('t2') && line.includes('stop failed')),
        'stopTask failure is logged',
      );
    } finally {
      restore();
    }
  });

  it('is a no-op when nothing is running', async () => {
    const events: SseEvent[] = [];
    const { client, calls } = createMockSdkClient();
    runtime = openRuntime(events, client);

    await runtime.stopAll();

    assert.strictEqual(calls.interrupt, 0);
    assert.strictEqual(calls.stopTask.length, 0);
    assert.strictEqual(processingEvents(events).length, 0, 'baseline idle emits nothing');
  });
});
