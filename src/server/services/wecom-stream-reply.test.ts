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
});
