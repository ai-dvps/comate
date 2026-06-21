import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Thread, StreamChunk } from 'chat';
import type * as lark from '@larksuiteoapi/node-sdk';
import { FeishuStreamReply } from './feishu-stream-reply.js';
import type { SseEvent } from '../types/message.js';

describe('FeishuStreamReply', { concurrency: false }, () => {
  let postedCards: unknown[];
  let mockThread: Thread;
  let mockClient: lark.Client;

  beforeEach(() => {
    postedCards = [];
    mockThread = {} as Thread;
    mockClient = {
      im: {
        message: {
          create: async (params: unknown) => {
            postedCards.push(params);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    } as unknown as lark.Client;
  });

  function createReply(options?: { onWaiting?: () => void }) {
    return new FeishuStreamReply(
      mockThread,
      mockClient,
      'openid-1',
      'ws-1',
      'session-1',
      options,
    );
  }

  async function collectStream(stream: AsyncIterable<StreamChunk>) {
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it('opens with a placeholder and yields text deltas', async () => {
    const reply = createReply();
    const { handler, stream } = reply.start();

    const collectPromise = collectStream(stream);

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'text_delta', text: 'hello' } as SseEvent);
    handler(1, { type: 'assistant_done' } as SseEvent);
    handler(1, { type: 'result', isError: false } as SseEvent);

    const chunks = await collectPromise;

    assert.strictEqual(chunks[0]?.type, 'markdown_text');
    assert.ok((chunks[0] as { text: string }).text.includes('收到'));
    assert.ok(chunks.some((c) => c.type === 'markdown_text' && (c as { text: string }).text === 'hello'));
  });

  it('posts an approval card on pending_approval and fires onWaiting once', async () => {
    let waitingCount = 0;
    const reply = createReply({ onWaiting: () => waitingCount++ });
    const { handler } = reply.start();

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      title: 'Run command?',
      description: 'Confirm this command',
      inputSummary: 'ls',
    } as SseEvent);

    // Multiple pending_approval events with the same requestId should dedupe.
    handler(1, {
      type: 'pending_approval',
      requestId: 'req-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
    } as SseEvent);

    assert.strictEqual(waitingCount, 1);
    assert.strictEqual(postedCards.length, 1);
    const card = JSON.parse(((postedCards[0] as { data: { content: string } }).data.content));
    assert.strictEqual(card.header?.title?.content, '需要你的确认');
  });

  it('posts a question card on pending_question', async () => {
    const reply = createReply();
    const { handler } = reply.start();

    handler(1, {
      type: 'pending_question',
      requestId: 'req-2',
      questions: [
        {
          question: 'Choose one',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    } as SseEvent);

    assert.strictEqual(postedCards.length, 1);
    const card = JSON.parse(((postedCards[0] as { data: { content: string } }).data.content));
    assert.strictEqual(card.header?.title?.content, '需要你的回答');
  });

  it('sends a timeout card on approval_timeout', async () => {
    const reply = createReply();
    const { handler } = reply.start();

    handler(1, { type: 'approval_timeout', requestId: 'req-3' } as SseEvent);

    assert.strictEqual(postedCards.length, 1);
    const card = JSON.parse(((postedCards[0] as { data: { content: string } }).data.content));
    const firstElement = card.elements?.[0];
    assert.strictEqual(firstElement?.text?.content, '⏰ 请求已超时，已按拒绝处理。');
  });
});