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

  it('delivers a second main-agent result proactively after the safeguard, carrying only its new content (AE1/AE3)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const afterFirst = calls.filter((c) => c.method === 'sendMessage').length;
    assert.strictEqual(afterFirst, 2, '1 notice + 1 first-result chunk');

    // Second turn: a fresh assistant message re-arms collection, then its result.
    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 3, '1 notice + 2 result chunks');
    assert.ok(sends[2].text.includes('second'), 'second chunk carries new content');
    assert.ok(!sends[2].text.includes('first'), 'second chunk does not re-paste the first result');
    handler.cleanup();
  });
});

describe('wecom-stream-reply multi-result delivery', { concurrency: false }, () => {
  beforeEach(() => {
    __setSafeguardDelayForTesting(2000); // keep the 9-minute safeguard out of the way
  });

  afterEach(() => {
    __restoreSafeguardDelay();
  });

  it('delivers the first result as the passive bubble and a later result as a proactive delta (AE3)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      1,
      'first result finishes the passive bubble once',
    );
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'no proactive send for the first result');

    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'second result delivered proactively');
    assert.ok(sends[0].text.includes('second'), 'proactive chunk carries new content');
    assert.ok(!sends[0].text.includes('first'), 'proactive chunk does not re-paste the bubble content');
    handler.cleanup();
  });

  it('delivers the main-agent follow-up after a sub-agent and never sends sub-agent events (AE2)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'intro' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    handler(1, { type: 'subagent_start', parentToolUseId: 'p1', description: 'research' } as SseEvent);
    handler(1, { type: 'subagent_done', parentToolUseId: 'p1', state: 'completed' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(
      calls.filter((c) => c.method === 'sendMessage').length,
      0,
      'sub-agent lifecycle events never send a message',
    );

    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'follow-up' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'follow-up result delivered proactively');
    assert.ok(sends[0].text.includes('follow-up'), 'proactive chunk carries the follow-up');
    assert.ok(!sends[0].text.includes('intro'), 'proactive chunk does not re-paste the bubble content');
    handler.cleanup();
  });

  it('delivers an error result proactively with the failure suffix after the bubble is finished (AE4)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'err detail' } as SseEvent);
    handler(1, { type: 'result', isError: true } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'error result delivered proactively');
    assert.ok(sends[0].text.includes('err detail'), 'proactive chunk carries the error detail');
    assert.ok(sends[0].text.includes('⚠️ 处理失败，请稍后重试。'), 'proactive chunk carries the failure suffix');
    handler.cleanup();
  });

  it('sends nothing for an empty result after the bubble is finished, yet still delivers a later non-empty result (AE4)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    // Empty second result: no new turn, nothing accumulated since the first delivery.
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'empty result sends nothing');

    // A later non-empty result is still delivered.
    handler(1, { type: 'assistant_start', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm3', text: 'third' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'later non-empty result delivered');
    assert.ok(sends[0].text.includes('third'), 'proactive chunk carries the later result');
    handler.cleanup();
  });

  it('falls back with the bubble snapshot when the final frame fails after a later result grew the buffer', async () => {
    let rejectFinal: ((err: Error) => void) | null = null;
    const calls: Array<{ method: string; text: string; finish?: boolean }> = [];
    const conn: StreamReplyConnection = {
      client: {
        replyStream: async (_frame, _streamId, text, finish) => {
          calls.push({ method: 'replyStream', text, finish });
          if (finish) {
            // Hold the final frame unsettled so the second turn can grow the buffer first.
            await new Promise((_resolve, reject) => {
              rejectFinal = reject;
            });
          }
        },
        replyStreamNonBlocking: async (_frame, _streamId, text, finish) => {
          calls.push({ method: 'replyStreamNonBlocking', text, finish });
        },
        sendMessage: async (_userId, body) => {
          calls.push({
            method: 'sendMessage',
            text: (body as { markdown?: { content?: string } })?.markdown?.content ?? '',
          });
        },
      },
      sendTemplateCard: async () => {},
    };
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent); // final bubble frame stays pending

    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    rejectFinal!(new Error('final frame rejected'));
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 2, 'proactive second result plus snapshot fallback');
    assert.ok(sends[0].text.includes('second'), 'second result delivered proactively');
    assert.ok(sends[1].text.includes('first'), 'fallback carries the first result snapshot');
    assert.ok(!sends[1].text.includes('second'), 'fallback does not re-send the later result');
    handler.cleanup();
  });

  it('serializes overlapping proactive deliveries so results arrive in emission order', async () => {
    let resolveFirst: (() => void) | null = null;
    const settled: string[] = [];
    let sendCount = 0;
    const conn: StreamReplyConnection = {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (_userId, body) => {
          sendCount += 1;
          const text = (body as { markdown?: { content?: string } })?.markdown?.content ?? '';
          if (sendCount === 1) {
            await new Promise<void>((resolve) => {
              resolveFirst = resolve;
            });
          }
          settled.push(text);
        },
      },
      sendTemplateCard: async () => {},
    };
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    // Second result: its proactive send is held in flight...
    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(sendCount, 1, 'second result send is in flight');
    assert.deepStrictEqual(settled, [], 'nothing settled while the first send is held');

    // ...while a third result arrives; without serialization its send would
    // overtake the second result on the wire.
    handler(1, { type: 'assistant_start', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm3', text: 'third' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(sendCount, 1, 'third result waits behind the in-flight delivery');

    resolveFirst!();
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(sendCount, 2, 'third result delivered after the second settles');
    assert.ok(settled[0].includes('second'), 'second result settles first');
    assert.ok(settled[1].includes('third'), 'third result settles after');
    assert.ok(!settled[1].includes('second'), 'third result carries only its own delta');
    handler.cleanup();
  });

  it('redelivers content whose proactive chunk failed when the next result arrives', async () => {
    const successful: string[] = [];
    let attempts = 0;
    const conn: StreamReplyConnection = {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async () => {},
        sendMessage: async (_userId, body) => {
          attempts += 1;
          if (attempts <= 2) throw new Error('send failed');
          successful.push((body as { markdown?: { content?: string } })?.markdown?.content ?? '');
        },
      },
      sendTemplateCard: async () => {},
    };
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    // Second result: its single chunk fails twice and is aborted.
    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(attempts, 2, 'failed chunk retried once then aborted');
    assert.strictEqual(successful.length, 0, 'nothing delivered yet');

    // Third result: the aborted content rides along instead of being dropped.
    handler(1, { type: 'assistant_start', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm3', text: 'third' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm3' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(successful.length, 1, 'third result delivered in one chunk');
    assert.ok(successful[0].includes('second'), 'aborted content redelivered');
    assert.ok(successful[0].includes('third'), 'new content delivered');
    assert.ok(!successful[0].includes('first'), 'bubble content not re-sent');
    handler.cleanup();
  });

  it('still sends approval and question cards raised after the first result finishes the bubble', async () => {
    const { conn } = makeTrackingConn();
    const sentCards: any[] = [];
    const cardConn: StreamReplyConnection = {
      ...conn,
      sendTemplateCard: async (card) => {
        sentCards.push(card);
      },
    };
    const { handler } = createStreamReply(cardConn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-a2',
      toolName: 'Bash',
      toolUseId: 'tu-2',
      input: { command: 'ls' },
      inputSummary: 'ls',
      title: 'Run command?',
      description: 'Confirm this command',
    } as SseEvent);
    handler(1, {
      type: 'pending_question',
      requestId: 'req-q2',
      questions: [
        {
          question: 'Choose one',
          header: 'Question header',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    } as SseEvent);
    // Same requestId again: still deduped across turns.
    handler(1, {
      type: 'pending_approval',
      requestId: 'req-a2',
      toolName: 'Bash',
      toolUseId: 'tu-2',
      input: { command: 'ls' },
      inputSummary: 'ls',
      title: 'Run command?',
      description: 'Confirm this command',
    } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(sentCards.length, 2, 'approval + question cards sent after the first result; duplicate requestId deduped');
    handler.cleanup();
  });

  it('keeps the passive channel silent once the bubble is finished (KTD-3)', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const passiveBefore = calls.filter((c) => c.method === 'replyStreamNonBlocking').length;
    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'thinking_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'tool_use_start', messageId: 'm2', toolName: 'Bash' } as SseEvent);
    handler(1, { type: 'subagent_start', parentToolUseId: 'p1', description: 'research' } as SseEvent);
    handler(1, { type: 'subagent_done', parentToolUseId: 'p1', state: 'completed' } as SseEvent);
    await new Promise((r) => setTimeout(r, 200)); // flush debounce window passes
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStreamNonBlocking').length,
      passiveBefore,
      'no passive refresh after the bubble is finished',
    );

    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'second result delivered proactively');
    assert.ok(sends[0].text.includes('second'), 'proactive chunk carries new content');
    for (const marker of ['收到，正在处理中', '🔧', '🤖']) {
      assert.ok(!sends[0].text.includes(marker), `no placeholder text "${marker}" in proactive content`);
    }
    handler.cleanup();
  });

  it('delivers an error_note after the bubble finishes as a proactive delta', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    handler(1, { type: 'error_note', text: 'boom' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'error_note delivered proactively');
    assert.ok(sends[0].text.includes('⚠️ boom'), 'error note text present');
    assert.ok(!sends[0].text.includes('first'), 'bubble content not re-sent');
    handler.cleanup();
  });

  it('never fires the safeguard notice once an early result has finished the bubble (R4)', async () => {
    __setSafeguardDelayForTesting(50);
    const { conn, calls } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'first' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 100)); // well past the safeguard delay
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'no notice after an early result');

    handler(1, { type: 'assistant_start', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm2', text: 'second' } as SseEvent);
    handler(1, { type: 'assistant_done', messageId: 'm2' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const sends = calls.filter((c) => c.method === 'sendMessage');
    assert.strictEqual(sends.length, 1, 'late second result delivered proactively, still no notice');
    assert.ok(sends[0].text.includes('second'));
    assert.ok(!sends[0].text.includes('更长的时间'), 'safeguard notice never fired');
    handler.cleanup();
  });
});

describe('wecom-stream-reply interrupt', { concurrency: false }, () => {
  beforeEach(() => {
    __setSafeguardDelayForTesting(2000);
  });

  afterEach(() => {
    __restoreSafeguardDelay();
  });

  function makeFrame(): any {
    return {
      headers: { req_id: 'req-int' },
      body: { msgid: 'msg-int', from: { userid: 'user-1' }, msgtype: 'text', text: { content: 'hi' } },
    };
  }

  it('appends the interrupt marker and finalizes the passive stream', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, interrupt } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'partial answer' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const didInterrupt = interrupt('已中断');
    assert.strictEqual(didInterrupt, true);

    await new Promise((r) => setTimeout(r, 20));
    const finalCalls = calls.filter((c) => c.method === 'replyStream' && c.finish === true);
    assert.strictEqual(finalCalls.length, 1);
    assert.ok(finalCalls[0].text.includes('partial answer'));
    assert.ok(finalCalls[0].text.includes('已中断'));
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0);

    handler.cleanup();
  });

  it('returns false when the safeguard has already fired', async () => {
    __setSafeguardDelayForTesting(50);
    const { conn, calls } = makeTrackingConn();
    const { handler, interrupt } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires

    const didInterrupt = interrupt('已中断');
    assert.strictEqual(didInterrupt, false);
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      0,
    );

    handler.cleanup();
  });

  it('returns false once the stream is already finalized', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, interrupt } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const didInterrupt = interrupt('已中断');
    assert.strictEqual(didInterrupt, false);
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      1,
    );

    handler.cleanup();
  });

  it('calls onFinalized once when the stream finalizes', async () => {
    let finalizedCount = 0;
    let cleanupCount = 0;
    const { conn } = makeTrackingConn();
    const { handler } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1', {
      onFinalized: () => finalizedCount++,
      onCleanup: () => cleanupCount++,
    });

    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(finalizedCount, 1);

    handler(1, { type: 'result' } as SseEvent); // second terminal
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(finalizedCount, 1, 'onFinalized should fire only once');

    handler.cleanup();
    assert.strictEqual(cleanupCount, 1);
  });

  it('is safe to call interrupt after a runtime interrupted event has already finalized', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, interrupt } = createStreamReply(conn, makeFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'answer' } as SseEvent);
    handler(1, { type: 'interrupted' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const didInterrupt = interrupt('已中断');
    assert.strictEqual(didInterrupt, false);
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      1,
    );

    handler.cleanup();
  });
});

describe('wecom-stream-reply appendNarrative', { concurrency: false }, () => {
  beforeEach(() => {
    __setSafeguardDelayForTesting(2000);
  });

  afterEach(() => {
    __restoreSafeguardDelay();
  });

  it('appends a block that precedes continued text and does not finalize', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'preamble' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const ok = appendNarrative('❓Q\n↳ 你的选择：A');
    assert.strictEqual(ok, true);

    handler(1, { type: 'text_delta', messageId: 'm1', text: ' continued answer' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const finalCalls = calls.filter((c) => c.method === 'replyStream' && c.finish === true);
    assert.strictEqual(finalCalls.length, 1, 'only the genuine finalize sets finish=true');
    const text = finalCalls[0].text;
    assert.ok(text.includes('preamble'), 'preamble present');
    assert.ok(text.includes('❓Q'), 'fold question present');
    assert.ok(text.includes('↳ 你的选择：A'), 'fold choice present');
    assert.ok(text.includes('continued answer'), 'continued text present');
    assert.ok(
      text.indexOf('preamble') < text.indexOf('❓Q') && text.indexOf('❓Q') < text.indexOf('continued answer'),
      'bubble reads preamble → fold → continued answer',
    );
    assert.strictEqual(calls.filter((c) => c.method === 'sendMessage').length, 0, 'no proactive send on fast path');
    handler.cleanup();
  });

  it('returns false and changes nothing once the stream is finalized', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'done' } as SseEvent);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    const finishBefore = calls.filter((c) => c.method === 'replyStream' && c.finish === true).length;
    const ok = appendNarrative('❓late');
    assert.strictEqual(ok, false);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      finishBefore,
      'no additional finalize frame',
    );
    const finalText = calls.filter((c) => c.method === 'replyStream' && c.finish === true)[0].text;
    assert.ok(!finalText.includes('❓late'), 'late block not appended');
    handler.cleanup();
  });

  it('returns false and changes nothing after the safeguard has fired', async () => {
    __setSafeguardDelayForTesting(50);
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'partial' } as SseEvent);
    await new Promise((r) => setTimeout(r, 80)); // safeguard fires

    const ok = appendNarrative('❓late');
    assert.strictEqual(ok, false);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      calls.filter((c) => c.method === 'replyStream' && c.finish === true).length,
      0,
      'no finalize frame',
    );
    assert.strictEqual(
      calls.filter((c) => c.method === 'sendMessage').length,
      1,
      'only the safeguard notice was sent',
    );
    handler.cleanup();
  });

  it('keeps exactly one blank line before each appended block', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'pre' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    appendNarrative('block-A');
    appendNarrative('block-B');
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const text = calls.filter((c) => c.method === 'replyStream' && c.finish === true)[0].text;
    assert.ok(
      text.includes('pre\n\nblock-A\n\nblock-B'),
      `single blank-line separators, got: ${JSON.stringify(text)}`,
    );
    assert.ok(!text.includes('\n\n\n'), 'no triple blank lines');
    handler.cleanup();
  });

  it('clears an active placeholder rather than duplicating it above the block', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'pre' } as SseEvent);
    handler(1, { type: 'tool_use_start', messageId: 'm1', toolName: 'Bash' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    appendNarrative('❓Q');
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const text = calls.filter((c) => c.method === 'replyStream' && c.finish === true)[0].text;
    assert.ok(!text.includes('🔧'), `placeholder cleared from final text, got: ${JSON.stringify(text)}`);
    assert.ok(text.includes('❓Q'), 'block present');
    handler.cleanup();
  });

  it('returns false and changes nothing for empty or whitespace-only text', async () => {
    const { conn, calls } = makeTrackingConn();
    const { handler, appendNarrative } = createStreamReply(conn, makeSafeguardFrame(), 'sess-1', 'user-1');
    handler(1, { type: 'assistant_start', messageId: 'm1' } as SseEvent);
    handler(1, { type: 'text_delta', messageId: 'm1', text: 'pre' } as SseEvent);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(appendNarrative(''), false);
    assert.strictEqual(appendNarrative('   \n  '), false);
    handler(1, { type: 'result' } as SseEvent);
    await new Promise((r) => setTimeout(r, 30));

    const text = calls.filter((c) => c.method === 'replyStream' && c.finish === true)[0].text;
    assert.strictEqual(text.trim(), 'pre', `no trailing blank lines appended, got: ${JSON.stringify(text)}`);
    handler.cleanup();
  });
});
