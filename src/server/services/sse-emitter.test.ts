import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Response } from 'express';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SseEmitter } from './sse-emitter.js';

describe('SseEmitter diagnostics', { concurrency: false }, () => {
  it('does not write high-frequency text deltas to console', () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      const emitter = new SseEmitter({
        write: () => true,
      } as unknown as Response);

      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      } as unknown as SDKMessage);
      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
      } as unknown as SDKMessage);

      calls.length = 0;

      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      } as unknown as SDKMessage);

      assert.deepStrictEqual(calls, []);
    } finally {
      console.log = originalLog;
    }
  });
});
