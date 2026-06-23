import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type * as lark from '@larksuiteoapi/node-sdk';
import { FeishuCardStream } from './feishu-card-stream.js';

interface MockCall {
  method: string;
  args: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertUuidV4(uuid: string): void {
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid),
    `expected UUID v4, got ${uuid}`,
  );
}

describe('FeishuCardStream', { concurrency: false }, () => {
  let calls: MockCall[] = [];
  let createShouldFail = false;
  let messageShouldFail = false;
  let contentShouldFail = false;
  let settingsShouldFail = false;
  let cardSequence = 0;

  function makeMockClient(): lark.Client {
    return {
      cardkit: {
        v1: {
          card: {
            create: async (args: unknown) => {
              calls.push({ method: 'card.create', args });
              if (createShouldFail) throw new Error('card create failed');
              cardSequence += 1;
              return { data: { card_id: `card-${cardSequence}` } };
            },
            settings: async (args: unknown) => {
              calls.push({ method: 'card.settings', args });
              if (settingsShouldFail) throw new Error('card settings failed');
              return { data: {} };
            },
          },
          cardElement: {
            content: async (args: unknown) => {
              calls.push({ method: 'cardElement.content', args });
              if (contentShouldFail) throw new Error('cardElement content failed');
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
              if (messageShouldFail) throw new Error('im.message.create failed');
              return { data: { message_id: `msg-${cardSequence}` } };
            },
          },
        },
      },
    } as unknown as lark.Client;
  }

  beforeEach(() => {
    calls = [];
    createShouldFail = false;
    messageShouldFail = false;
    contentShouldFail = false;
    settingsShouldFail = false;
    cardSequence = 0;
  });

  it('creates a card and sends a message referencing it', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    const result = await stream.start('收到，正在处理...');

    assert.strictEqual(result.cardId, 'card-1');
    assert.strictEqual(result.messageId, 'msg-1');

    assert.strictEqual(calls.filter((c) => c.method === 'card.create').length, 1);
    assert.strictEqual(calls.filter((c) => c.method === 'im.message.create').length, 1);

    const createCall = calls.find((c) => c.method === 'card.create')?.args as {
      data: { type: string; data: string };
    };
    const cardJson = JSON.parse(createCall.data.data);
    assert.strictEqual(cardJson.schema, '2.0');
    assert.strictEqual(cardJson.config.streaming_mode, true);
    assert.deepStrictEqual(Object.keys(cardJson.config).sort(), [
      'streaming_config',
      'streaming_mode',
      'summary',
    ]);
    assert.strictEqual(cardJson.body.elements[0].element_id, 'stream_md');
    assert.strictEqual(cardJson.body.elements[0].content, '收到，正在处理...');

    const messageCall = calls.find((c) => c.method === 'im.message.create')?.args as {
      params: { receive_id_type: string };
      data: { receive_id: string; msg_type: string; content: string };
    };
    assert.strictEqual(messageCall.params.receive_id_type, 'open_id');
    assert.strictEqual(messageCall.data.receive_id, 'ou_123');
    assert.strictEqual(messageCall.data.msg_type, 'interactive');
    const messageContent = JSON.parse(messageCall.data.content);
    assert.strictEqual(messageContent.type, 'card');
    assert.strictEqual(messageContent.data.card_id, 'card-1');
  });

  it('throws when card creation fails', async () => {
    createShouldFail = true;
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await assert.rejects(() => stream.start('hint'), /card create failed/);
    assert.strictEqual(calls.filter((c) => c.method === 'im.message.create').length, 0);
  });

  it('throws when initial message send fails', async () => {
    messageShouldFail = true;
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await assert.rejects(() => stream.start('hint'), /im.message.create failed/);
    assert.strictEqual(calls.filter((c) => c.method === 'card.create').length, 1);
  });

  it('throttles multiple setContent calls into a single update', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123', {
      streamThrottleMs: 30,
      streamThrottleChars: 10,
    });
    await stream.start('initial');
    calls = [];

    stream.setContent('a');
    stream.setContent('ab');
    stream.setContent('abc');

    await sleep(60);

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    const contentArgs = contentCalls[0].args as {
      path: { card_id: string; element_id: string };
      data: { content: string; sequence: number; uuid: string };
    };
    assert.strictEqual(contentArgs.data.content, 'abc');
    assert.strictEqual(contentArgs.data.sequence, 1);
    assertUuidV4(contentArgs.data.uuid);
  });

  it('never sends empty or whitespace-only content (Feishu requires min len 1)', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123', {
      streamThrottleMs: 10,
      streamThrottleChars: 1,
    });
    await stream.start('initial');
    calls = [];

    // Empty string, whitespace-only, and zero-width space must all be dropped.
    stream.setContent('');
    stream.setContent('   ');
    stream.setContent('​'); // U+200B zero-width space
    await sleep(30);

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 0);

    // A real update still goes through after the rejected ones.
    stream.setContent('real text');
    await sleep(30);
    const realCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(realCalls.length, 1);
    assert.strictEqual(
      (realCalls[0].args as { data: { content: string } }).data.content,
      'real text',
    );
  });

  it('fires immediately when enough characters accumulate', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123', {
      streamThrottleMs: 10_000,
      streamThrottleChars: 5,
    });
    await stream.start('initial');
    calls = [];

    stream.setContent('12345');
    await sleep(10);

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      '12345',
    );
  });

  it('finish commits the final text and disables streaming mode', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123', {
      streamThrottleMs: 30,
      streamThrottleChars: 10,
    });
    await stream.start('initial');

    stream.setContent('partial answer');
    await stream.finish('final answer');

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    const lastContent = contentCalls[contentCalls.length - 1]?.args as {
      data: { content: string };
    };
    assert.strictEqual(lastContent?.data.content, 'final answer');

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
    const settingsArgs = settingsCalls[0].args as {
      path: { card_id: string };
      data: { settings: string; sequence: number; uuid: string };
    };
    assert.strictEqual(settingsArgs.path.card_id, 'card-1');
    assertUuidV4(settingsArgs.data.uuid);
    const settingsPayload = JSON.parse(settingsArgs.data.settings);
    assert.strictEqual(settingsPayload.config.streaming_mode, false);
    assert.strictEqual(settingsPayload.config.summary.content, 'final answer');
  });

  it('finish pushes a final content update even when no setContent was called', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await stream.start('initial');

    await stream.finish('final answer');

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(
      (contentCalls[0].args as { data: { content: string } }).data.content,
      'final answer',
    );

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
  });

  it('finish with empty text does not push a content update', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await stream.start('initial');

    await stream.finish('');

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 0);

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
  });

  it('returns the same promise when finish is called multiple times', async () => {
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await stream.start('initial');

    const p1 = stream.finish('final');
    const p2 = stream.finish('ignored');
    assert.strictEqual(p1, p2);

    await p1;

    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
    const settingsPayload = JSON.parse(
      (settingsCalls[0].args as { data: { settings: string } }).data.settings,
    );
    assert.strictEqual(settingsPayload.config.summary.content, 'final');
  });

  it('logs and swallows content update errors without throwing', async () => {
    contentShouldFail = true;
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123', {
      streamThrottleMs: 10,
      streamThrottleChars: 1,
    });
    await stream.start('initial');
    calls = [];

    stream.setContent('x');
    await sleep(30);

    // No thrown error; subsequent updates are still attempted.
    stream.setContent('y');
    await sleep(30);

    const contentCalls = calls.filter((c) => c.method === 'cardElement.content');
    assert.strictEqual(contentCalls.length, 2);

    // finish should still attempt settings.
    await stream.finish('final');
    const settingsCalls = calls.filter((c) => c.method === 'card.settings');
    assert.strictEqual(settingsCalls.length, 1);
  });

  it('logs settings failures without throwing', async () => {
    settingsShouldFail = true;
    const client = makeMockClient();
    const stream = new FeishuCardStream(client, 'ou_123');
    await stream.start('initial');
    await assert.doesNotReject(() => stream.finish('final'));
  });
});
