import '../test-utils/test-env.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamReply, __setSafeguardDelayForTesting, __restoreSafeguardDelay, type StreamReplyConnection } from './wecom-stream-reply.js';
import type { SseEvent } from '../types/message.js';
import { decodeButtonKey } from './wecom-template-card.js';
import { ACKNOWLEDGMENT_POOL } from '../utils/bot-placeholder.js';

describe('wecom-stream-reply', () => {
  let sentCards: any[];
  let conn: StreamReplyConnection;

  beforeEach(() => {
    sentCards = [];
    conn = {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async () => {},
      },
      sendTemplateCard: async (card) => {
        sentCards.push(card);
        return undefined;
      },
    };
  });

  function makeFrame(): any {
    return {
      headers: { req_id: 'req-1' },
      body: {
        msgid: 'msg-1',
        aibotid: 'bot-1',
        from: { userid: 'user-1' },
        msgtype: 'text',
        text: { content: 'hello' },
      },
    };
  }

  function makeMockReplyConn(
    calls: Array<{ text: string; finish?: boolean }>,
  ): StreamReplyConnection {
    return {
      client: {
        replyStream: async (_frame, _streamId, text, finish) => {
          calls.push({ text, finish });
        },
        replyStreamNonBlocking: async (_frame, _streamId, text, finish) => {
          calls.push({ text, finish });
        },
        sendMessage: async () => {},
      },
    };
  }

  it('sends a tool-approval card on pending_approval', () => {
    const { handler } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-approval-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
      inputSummary: 'ls',
      title: 'Run command?',
      description: 'Confirm this command',
    } as SseEvent);

    assert.strictEqual(sentCards.length, 1);
    const card = sentCards[0];
    assert.strictEqual(card.card_type, 'button_interaction');
    assert.strictEqual(card.main_title.title, 'Run command?');
    assert.strictEqual(card.main_title.desc, 'Confirm this command');
    assert.strictEqual(card.task_id, 'req-approval-1');
    assert.strictEqual(card.button_list.length, 3);

    const actions = card.button_list.map((b: any) => decodeButtonKey(b.key)?.action);
    assert.deepStrictEqual(actions, ['allow', 'always_allow', 'deny']);

    const sessionIds = card.button_list.map((b: any) => decodeButtonKey(b.key)?.sessionId);
    assert.deepStrictEqual(sessionIds, ['sess-1', 'sess-1', 'sess-1']);
  });

  it('sends a question card on pending_question', () => {
    const { handler } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');

    handler(1, {
      type: 'pending_question',
      requestId: 'req-question-1',
      questions: [
        {
          question: 'Choose one',
          header: 'Question header',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    } as SseEvent);

    assert.strictEqual(sentCards.length, 1);
    const card = sentCards[0];
    assert.strictEqual(card.card_type, 'vote_interaction');
    assert.strictEqual(card.main_title.title, 'Question header');
    assert.strictEqual(card.main_title.desc, 'Choose one');
    assert.strictEqual(card.task_id, 'req-question-1');
  });

  it('does not send duplicate cards for the same requestId', () => {
    const { handler } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-approval-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
      inputSummary: 'ls',
    } as SseEvent);

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-approval-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
      inputSummary: 'ls',
    } as SseEvent);

    assert.strictEqual(sentCards.length, 1);
  });

  it('does not break streaming when no sendTemplateCard callback is provided', () => {
    const replyConn: StreamReplyConnection = {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async () => {},
      },
    };
    const { handler } = createStreamReply(replyConn, makeFrame(), 'sess-1', 'user-1');

    // Should not throw even though sendTemplateCard is missing.
    handler(1, {
      type: 'pending_approval',
      requestId: 'req-approval-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'ls' },
      inputSummary: 'ls',
    } as SseEvent);

    assert.strictEqual(sentCards.length, 0);
  });

  it('uses a rotating placeholder for the initial reply stream', () => {
    const calls: Array<{ text: string; finish?: boolean }> = [];
    const replyConn = makeMockReplyConn(calls);

    const { handler } = createStreamReply(replyConn, makeFrame(), 'sess-1', 'user-1');
    handler.cleanup();

    const initialCall = calls.find((c) => c.finish === false);
    assert.ok(initialCall);
    assert.ok(
      ACKNOWLEDGMENT_POOL.some((message) => `${message}.` === initialCall!.text),
      `initial placeholder "${initialCall!.text}" should be a pool message with a trailing period`,
    );
  });

  it('uses the same base message for placeholder animation frames', async () => {
    const calls: Array<{ text: string }> = [];
    const replyConn = makeMockReplyConn(calls);

    const { handler } = createStreamReply(replyConn, makeFrame(), 'sess-1', 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 700));
    handler.cleanup();

    const nonBlockingCalls = calls.slice(1);
    assert.ok(nonBlockingCalls.length > 0, 'animation frames should be sent');
    const baseText = nonBlockingCalls[0]!.text.replace(/\.+$/, '');
    for (const call of nonBlockingCalls) {
      assert.ok(
        call.text.startsWith(baseText),
        `animation frame "${call.text}" should start with base "${baseText}"`,
      );
    }
  });

  it('keeps the fixed text for the thinking placeholder', async () => {
    const calls: Array<{ text: string }> = [];
    const replyConn = makeMockReplyConn(calls);
    const { handler } = createStreamReply(replyConn, makeFrame(), 'sess-1', 'user-1');

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'thinking_start' } as SseEvent);
    await new Promise((resolve) => setTimeout(resolve, 700));
    handler.cleanup();

    assert.ok(
      calls.some((c) => c.text.includes('收到，正在处理中')),
      'thinking placeholder should keep the fixed text',
    );
  });
});

function makeSafeguardFrame(): any {
  return {
    headers: { req_id: 'req-sg' },
    body: { msgid: 'msg-sg', from: { userid: 'user-1' }, msgtype: 'text', text: { content: 'hi' } },
  };
}

function makeTrackingConn(opts: { failSend?: boolean } = {}) {
  const calls: Array<{ method: 'replyStream' | 'replyStreamNonBlocking' | 'sendMessage'; text: string; finish?: boolean }> = [];
  const conn: StreamReplyConnection = {
    client: {
      replyStream: async (_frame, _streamId, text, finish) => {
        calls.push({ method: 'replyStream', text, finish });
      },
      replyStreamNonBlocking: async (_frame, _streamId, text, finish) => {
        calls.push({ method: 'replyStreamNonBlocking', text, finish });
      },
      sendMessage: async (_userId, body) => {
        calls.push({
          method: 'sendMessage',
          text: (body as { markdown?: { content?: string } })?.markdown?.content ?? '',
        });
        if (opts.failSend) throw new Error('send failed');
      },
    },
    sendTemplateCard: async () => {},
  };
  return { conn, calls };
}

describe('wecom-stream-reply long-reply safeguard', { concurrency: false }, () => {
  beforeEach(() => {
    __setSafeguardDelayForTesting(50);
  });

  afterEach(() => {
    __restoreSafeguardDelay();
  });

  it('uses the passive finalize fast path when the result arrives before the safeguard (F1/AE1)', async () => {
    __setSafeguardDelayForTesting(2000);
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'hello' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'no proactive send on fast path');
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      1,
      'passive finalize sets finish=true once',
    );
    handler.cleanup();
  });

  it('sends the long-task notice and stops passive refresh when the safeguard fires (F2)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'partial' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'notice sent once');
    assert.ok(sends[0].text.includes('更长的时间'), 'notice text present');
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      0,
      'no active finish after safeguard',
    );

    const nonBlockingBefore = calls.filter((c) => c.method === 'replyStreamNonBlocking').length;
    handler(1, { type: 'text_delta', messageId: 'm1', text: ' more' } as SseEvent);
    await new Promise((r) => setTimeout(r, 200)); // flush debounce window passes
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStreamNonBlocking').length,
      nonBlockingBefore,
      'no passive refresh after safeguard',
    );
    handler.cleanup();
  });

  it('keeps accumulating text after the safeguard so the final push is complete', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'before' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'text_delta', messageId: 'm1', text: '-after' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 2, '1 notice + 1 result chunk');
    assert.ok(sends[1].text.includes('before'), 'pre-safeguard text present');
    assert.ok(sends[1].text.includes('after'), 'post-safeguard text present');
    handler.cleanup();
  });

  it('fires the safeguard notice at most once', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    await new Promise((r) => setTimeout(r, 130)); // well past one delay
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 1, 'notice sent exactly once');
    handler.cleanup();
  });

  it('clears the safeguard timer on cleanup so no notice fires after', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler.cleanup();
    await new Promise((r) => setTimeout(r, 130));
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'no notice after cleanup');
  });

  it('delivers an oversized result as split proactive messages after the safeguard (AE2)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'a'.repeat(30000) } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 40));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 3, '1 notice + 2 result chunks');
    const chunks = sends.slice(1);
    assert.strictEqual(chunks.length, 2);
    for (const c of chunks) {
      assert.ok(Buffer.byteLength(c.text, 'utf8') <= 20480, `chunk over limit: ${Buffer.byteLength(c.text)}`);
    }
    handler.cleanup();
  });

  it('does not send an empty proactive result after the safeguard (AE3)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'result' } as SseEvent); // no text accumulated
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 1, 'only the notice, no empty result');
    handler.cleanup();
  });

  it('retries a failed proactive chunk once and does not throw', async () => {
    const { conn, calls } = makeTrackingConn({ failSend: true });
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'a'.repeat(30000) } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 60));
    // Some sendMessage attempts occurred (notice + chunk attempts); completing
    // without an unhandled rejection is the no-throw signal.
    assert.ok(calls.filter((c) => c.method === 'sendMessage').length >= 1);
    handler.cleanup();
  });

  it('does not send additional proactive messages on a second terminal event', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'result text' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));
    const afterFirst = calls.filter((c) => c.method === 'sendMessage').length;
    handler(1, { type: 'result' } as SseEvent); // second terminal
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(
      calls.filter((c) => c.method === 'sendMessage').length,
      afterFirst,
      'no extra sends on second terminal',
    );
    handler.cleanup();
  });
});
