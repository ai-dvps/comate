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
