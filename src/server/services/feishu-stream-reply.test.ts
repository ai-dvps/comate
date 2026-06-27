import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Thread } from 'chat';
import type * as lark from '@larksuiteoapi/node-sdk';
import { FeishuStreamReply, FALLBACK_TEXT } from './feishu-stream-reply.js';
import type { SseEvent } from '../types/message.js';
import { ACKNOWLEDGMENT_POOL } from '../utils/bot-placeholder.js';

interface MockCall {
  method: string;
  args: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FeishuStreamReply', { concurrency: false }, () => {
  let postedCards: unknown[];
  let calls: MockCall[];
  let mockThread: Thread;
  let mockClient: lark.Client;

  beforeEach(() => {
    postedCards = [];
    calls = [];
    mockThread = {} as Thread;
    mockClient = {
      cardkit: {
        v1: {
          card: {
            create: async (args: unknown) => {
              calls.push({ method: 'card.create', args });
              return { data: { card_id: 'card-1' } };
            },
            settings: async (args: unknown) => {
              calls.push({ method: 'card.settings', args });
              return { data: {} };
            },
          },
          cardElement: {
            content: async (args: unknown) => {
              calls.push({ method: 'cardElement.content', args });
              return { data: {} };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async (args: unknown) => {
              calls.push({ method: 'im.message.create', args });
              postedCards.push(args);
              return { data: { message_id: 'msg-1' } };
            },
          },
        },
      },
    } as unknown as lark.Client;
  });

  function createReply(options?: { onWaiting?: () => void; initialHint?: string }) {
    return new FeishuStreamReply(
      mockThread,
      mockClient,
      'openid-1',
      'ws-1',
      'session-1',
      options,
    );
  }

  function lastContentCall():
    | {
        path: { card_id: string; element_id: string };
        data: { content: string; sequence: number; uuid: string };
      }
    | undefined {
    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    return contentCalls[contentCalls.length - 1]?.args as {
      path: { card_id: string; element_id: string };
      data: { content: string; sequence: number; uuid: string };
    };
  }

  it('starts a streaming card with the default hint from the rotating pool', async () => {
    const reply = createReply();
    await reply.start();

    const createCall = calls.find((c) => c.method === 'card.create')?.args as {
      data: { type: string; data: string };
    };
    const cardJson = JSON.parse(createCall.data.data);
    assert.strictEqual(cardJson.config.streaming_mode, true);
    assert.ok(ACKNOWLEDGMENT_POOL.includes(cardJson.body.elements[0].content));
  });

  it('starts a streaming card with a custom hint', async () => {
    const reply = createReply({ initialHint: 'custom hint' });
    await reply.start();

    const createCall = calls.find((c) => c.method === 'card.create')?.args as {
      data: { type: string; data: string };
    };
    const cardJson = JSON.parse(createCall.data.data);
    assert.strictEqual(cardJson.body.elements[0].content, 'custom hint');
  });

  it('ignores thinking/tool/subagent placeholders before assistant_start', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

    handler(1, { type: 'thinking_start' } as SseEvent);
    handler(1, { type: 'tool_use_start', toolName: 'Bash' } as SseEvent);
    handler(1, { type: 'subagent_start', description: 'Running subagent' } as SseEvent);
    await sleep(150);

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 0, 'pre-turn placeholder events should not update the card');
  });

  it('removes the thinking placeholder when the first text delta arrives', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'thinking_start' } as SseEvent);
    await sleep(150);
    assert.ok(lastContentCall()?.data.content.includes('正在思考'));

    handler(1, { type: 'text_delta', text: 'hello' } as SseEvent);
    await sleep(150);
    assert.strictEqual(lastContentCall()?.data.content, 'hello');
  });

  it('removes the tool placeholder after tool_result', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'tool_use_start', toolName: 'Bash' } as SseEvent);
    await sleep(150);
    assert.ok(lastContentCall()?.data.content.includes('🔧 Bash'));
    const countAfterPlaceholder = calls.filter((c) => c.method === 'cardElement.content').length;

    handler(1, { type: 'tool_result' } as SseEvent);
    await sleep(150);
    // Feishu rejects empty content (min len 1), so the empty update after
    // clearing the placeholder is skipped — no new content call is made. The
    // card keeps showing the placeholder until real text arrives.
    const countAfterClear = calls.filter((c) => c.method === 'cardElement.content').length;
    assert.strictEqual(countAfterClear, countAfterPlaceholder);

    handler(1, { type: 'text_delta', text: 'result' } as SseEvent);
    await sleep(150);
    assert.strictEqual(lastContentCall()?.data.content, 'result');
  });

  it('removes the sub-agent placeholder after subagent_done', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'subagent_start', description: 'Running subagent' } as SseEvent);
    await sleep(150);
    assert.ok(lastContentCall()?.data.content.includes('🤖'));
    const countAfterPlaceholder = calls.filter((c) => c.method === 'cardElement.content').length;

    handler(1, { type: 'subagent_done' } as SseEvent);
    await sleep(150);
    // Feishu rejects empty content (min len 1), so the empty update after
    // clearing the placeholder is skipped — no new content call is made.
    const countAfterClear = calls.filter((c) => c.method === 'cardElement.content').length;
    assert.strictEqual(countAfterClear, countAfterPlaceholder);
  });

  it('finalizes with only the answer text on result', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'text_delta', text: 'final answer' } as SseEvent);
    handler(1, { type: 'assistant_done' } as SseEvent);
    handler(1, { type: 'result', isError: false } as SseEvent);

    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    const lastContent = contentCalls[contentCalls.length - 1]?.args as {
      data: { content: string };
    };
    assert.strictEqual(lastContent?.data.content, 'final answer');

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
    const settingsPayload = JSON.parse(
      (settingsCalls[0].args as { data: { settings: string } }).data.settings,
    );
    assert.strictEqual(settingsPayload.config.streaming_mode, false);
    assert.strictEqual(settingsPayload.config.summary.content, 'final answer');
  });

  it('includes an error footer on error_note and finalizes', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'error_note', text: 'something went wrong' } as SseEvent);
    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    const lastContent = contentCalls[contentCalls.length - 1]?.args as {
      data: { content: string };
    };
    assert.ok(lastContent?.data.content.includes('something went wrong'));

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
  });

  it('includes an error footer on result when isError is true', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'result', isError: true } as SseEvent);
    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    const lastContent = contentCalls[contentCalls.length - 1]?.args as {
      data: { content: string };
    };
    assert.ok(lastContent?.data.content.includes('处理失败'));
    assert.strictEqual(lastContent?.data.content, '\n\n⚠️ 处理失败，请稍后重试。');
  });

  it('replaces the placeholder with the fallback message on result with no model text', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'result', isError: false } as SseEvent);
    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      FALLBACK_TEXT,
    );

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
    const settingsPayload = JSON.parse(
      (settingsCalls[0].args as { data: { settings: string } }).data.settings,
    );
    assert.strictEqual(settingsPayload.config.summary.content, FALLBACK_TEXT);
  });

  it('replaces the placeholder with the fallback message on error_note with empty text', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'error_note', text: '' } as SseEvent);
    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      FALLBACK_TEXT,
    );
  });

  it('replaces the placeholder with the fallback message on interrupted with no model text', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'assistant_start' } as SseEvent);
    handler(1, { type: 'interrupted' } as SseEvent);
    await finalize();

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      FALLBACK_TEXT,
    );
  });

  it('does not duplicate the fallback message when finalize is called repeatedly on an empty answer', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'result', isError: false } as SseEvent);
    const p1 = finalize();
    const p2 = finalize();
    assert.strictEqual(p1, p2);
    await p1;

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      FALLBACK_TEXT,
    );
  });

  function parseCardContent(call: unknown): Record<string, unknown> | null {
    const content = (call as { data?: { content?: string } })?.data?.content;
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  function findPostedCard(predicate: (card: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
    for (const call of postedCards) {
      const card = parseCardContent(call);
      if (card && predicate(card)) return card;
    }
    return undefined;
  }

  it('posts an approval card on pending_approval and fires onWaiting once', async () => {
    let waitingCount = 0;
    const reply = createReply({ onWaiting: () => waitingCount++ });
    const { handler } = await reply.start();

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
      title: 'Run command?',
      description: 'Confirm this command',
      inputSummary: 'ls',
    } as SseEvent);

    handler(1, {
      type: 'pending_approval',
      requestId: 'req-1',
      toolName: 'Bash',
      toolUseId: 'tu-1',
    } as SseEvent);

    assert.strictEqual(waitingCount, 1);
    const card = findPostedCard((c) => c.body?.elements?.[0]?.content === '需要你的确认');
    assert.ok(card, 'approval card should be posted');
  });

  it('posts a question card on pending_question', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

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

    const card = findPostedCard((c) => c.body?.elements?.[0]?.content === '需要你的回答');
    assert.ok(card, 'question card should be posted');
  });

  it('sends a timeout card on approval_timeout', async () => {
    const reply = createReply();
    const { handler } = await reply.start();

    handler(1, { type: 'approval_timeout', requestId: 'req-3' } as SseEvent);

    const card = findPostedCard((c) => c.text === '⏰ 请求已超时，已按拒绝处理。');
    assert.ok(card, 'timeout text should be sent');
  });

  it('returns the same finish promise when finalize is called twice', async () => {
    const reply = createReply();
    const { handler, finalize } = await reply.start();

    handler(1, { type: 'result', isError: false } as SseEvent);
    const p1 = finalize();
    const p2 = finalize();
    assert.strictEqual(p1, p2);
    await p1;
  });
});
