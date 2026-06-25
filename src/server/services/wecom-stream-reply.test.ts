import '../test-utils/test-env.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamReply, type StreamReplyConnection } from './wecom-stream-reply.js';
import type { SseEvent } from '../types/message.js';
import { decodeButtonKey } from './wecom-template-card.js';

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
    const replyConn: StreamReplyConnection = {
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

    const { handler } = createStreamReply(replyConn, makeFrame(), 'sess-1', 'user-1');
    handler.cleanup();

    const initialCall = calls.find((c) => c.finish === false);
    assert.ok(initialCall);
    assert.notStrictEqual(initialCall!.text, '收到，正在处理中.');
    assert.ok(!initialCall!.text.includes('收到，正在处理中'));
  });

  it('uses the same base message for placeholder animation frames', async () => {
    const calls: Array<{ text: string }> = [];
    const replyConn: StreamReplyConnection = {
      client: {
        replyStream: async (_frame, _streamId, text) => {
          calls.push({ text });
        },
        replyStreamNonBlocking: async (_frame, _streamId, text) => {
          calls.push({ text });
        },
        sendMessage: async () => {},
      },
    };

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
    const replyConn: StreamReplyConnection = {
      client: {
        replyStream: async () => {},
        replyStreamNonBlocking: async (_frame, _streamId, text) => {
          calls.push({ text });
        },
        sendMessage: async () => {},
      },
    };
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
