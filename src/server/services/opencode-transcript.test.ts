import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  opencodeMessagesToSessionMessages,
  pairTaskToolCallsWithChildren,
  type OpencodeRestMessage,
} from './opencode-transcript.js';

describe('opencodeMessagesToSessionMessages', () => {
  it('preserves stored OpenCode usage for historical normalization', () => {
    const out = opencodeMessagesToSessionMessages([{
      info: { id: 'm-usage', role: 'assistant',
        tokens: { total: 35, input: 20, output: 8, reasoning: 3, cache: { read: 5, write: 2 } } },
      parts: [{ id: 'p1', type: 'text', messageID: 'm-usage', text: 'done' }],
    }]) as Array<{ message: { usage?: unknown } }>;

    assert.deepStrictEqual(out[0].message.usage, {
      total_tokens: 35, input_tokens: 20, output_tokens: 8,
      cache_read_input_tokens: 5, cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 3 },
    });
  });

  it('translates text/reasoning/tool parts into claude-shaped messages', () => {
    const messages: OpencodeRestMessage[] = [
      {
        info: { id: 'm1', role: 'assistant' },
        parts: [
          { id: 'p1', type: 'reasoning', messageID: 'm1', text: 'thinking' },
          { id: 'p2', type: 'text', messageID: 'm1', text: 'answer' },
          {
            id: 'p3',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-1',
            tool: 'write',
            state: { status: 'completed', input: { filePath: '/a' }, output: 'done' },
          },
        ],
      },
    ];
    const out = opencodeMessagesToSessionMessages(messages) as Array<{
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    }>;
    assert.equal(out.length, 2);
    const [assistant, toolResult] = out;
    assert.equal(assistant.type, 'assistant');
    const types = assistant.message.content.map((b) => b.type);
    assert.deepEqual(types, ['thinking', 'text', 'tool_use']);
    const toolUse = assistant.message.content[2] as { name: string; input: unknown };
    assert.equal(toolUse.name, 'Write');
    assert.deepEqual(toolUse.input, { filePath: '/a' });
    assert.equal(toolResult.type, 'user');
    const resultBlock = toolResult.message.content[0] as { type: string; is_error: boolean };
    assert.equal(resultBlock.type, 'tool_result');
    assert.equal(resultBlock.is_error, false);
  });

  it('emits errored tool results as is_error', () => {
    const out = opencodeMessagesToSessionMessages([
      {
        info: { id: 'm1', role: 'assistant' },
        parts: [
          {
            id: 'p1',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-1',
            tool: 'read',
            state: { status: 'error', input: {}, error: 'ENOENT' },
          },
        ],
      },
    ]) as Array<{ message: { content: Array<Record<string, unknown>> } }>;
    const result = out[1].message.content[0] as { is_error: boolean; content: string };
    assert.equal(result.is_error, true);
    assert.equal(result.content, 'ENOENT');
  });

  it('maps persisted data URL images to shared base64 image parts', () => {
    const out = opencodeMessagesToSessionMessages([{
      info: { id: 'm-image', role: 'user' },
      parts: [
        { id: 'p-before', type: 'text', messageID: 'm-image', text: 'before' },
        {
          id: 'p-image',
          type: 'file',
          messageID: 'm-image',
          mime: 'image/webp',
          filename: '../screen.webp',
          url: 'data:image/webp;base64,UklGRg==',
        },
        { id: 'p-after', type: 'text', messageID: 'm-image', text: 'after' },
      ],
    }]) as Array<{ message: { content: Array<Record<string, unknown>> } }>;

    assert.deepEqual(out[0].message.content, [
      { type: 'text', text: 'before' },
      {
        type: 'image',
        mediaType: 'image/webp',
        name: 'screen.webp',
        source: { type: 'base64', data: 'UklGRg==' },
      },
      { type: 'text', text: 'after' },
    ]);
  });

  it('marks remote image URLs unavailable without creating a network source', () => {
    const out = opencodeMessagesToSessionMessages([{
      info: { id: 'm-remote', role: 'user' },
      parts: [{
        id: 'p-remote',
        type: 'file',
        messageID: 'm-remote',
        mime: 'image/png',
        filename: 'remote.png',
        url: 'https://cdn.example.test/remote.png',
      }],
    }]) as Array<{ message: { content: Array<Record<string, unknown>> } }>;

    assert.deepEqual(out[0].message.content, [{
      type: 'image',
      mediaType: 'image/png',
      name: 'remote.png',
      source: { type: 'unavailable', reason: 'Backend transcript image URL is unavailable.' },
    }]);
  });

  it('restores a reserved OpenCode message id to the stable client UUID', () => {
    const out = opencodeMessagesToSessionMessages([{
      info: { id: 'msg_comate_550e8400e29b41d4a716446655440000', role: 'user' },
      parts: [{ id: 'p1', type: 'text', messageID: 'msg_comate_550e8400e29b41d4a716446655440000', text: 'hello' }],
    }]);
    assert.equal(out[0].uuid, '550e8400-e29b-41d4-a716-446655440000');
  });

  it('marks missing, invalid, unsafe, and compacted image data unavailable', () => {
    const out = opencodeMessagesToSessionMessages([{
      info: { id: 'm-broken', role: 'user' },
      parts: [
        { id: 'missing', type: 'file', messageID: 'm-broken', mime: 'image/png', filename: 'missing.png' },
        { id: 'invalid', type: 'file', messageID: 'm-broken', mime: 'image/jpeg', url: 'data:image/jpeg;base64,***' },
        { id: 'unsafe', type: 'file', messageID: 'm-broken', mime: 'image/webp', url: 'file:///tmp/image.webp' },
        {
          id: 'compacted',
          type: 'file',
          messageID: 'm-broken',
          mime: 'image/gif',
          url: 'data:image/gif;base64,R0lGODlh',
          compacted: true,
        },
      ],
    }]) as Array<{ message: { content: Array<{ source: { type: string; reason?: string } }> } }>;

    assert.deepEqual(out[0].message.content.map((part) => part.source.type), [
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    for (const part of out[0].message.content) assert.ok(part.source.reason);
  });
});

describe('pairTaskToolCallsWithChildren', () => {
  it('pairs task tool calls in order with descriptions', () => {
    const parent: OpencodeRestMessage[] = [
      {
        info: { id: 'm1', role: 'assistant' },
        parts: [
          {
            id: 'p1',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-a',
            tool: 'task',
            state: { status: 'completed', input: { description: 'explore the codebase' }, output: '' },
          },
          {
            id: 'p2',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-b',
            tool: 'write',
            state: { status: 'completed', input: {}, output: '' },
          },
          {
            id: 'p3',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-c',
            tool: 'task',
            state: { status: 'running', input: { prompt: 'second agent does a much longer thing' }, output: '' },
          },
        ],
      },
    ];
    const pairings = pairTaskToolCallsWithChildren(parent, 2);
    assert.deepEqual(pairings, [
      { parentToolUseId: 'call-a', description: 'explore the codebase' },
      { parentToolUseId: 'call-c', description: 'second agent does a much longer thing' },
    ]);
  });
});

describe('errored turn history (silent-error fix)', () => {
  it('emits a visible error entry after a failed assistant message', () => {
    const out = opencodeMessagesToSessionMessages([
      {
        info: {
          id: 'm1',
          role: 'assistant',
          error: { name: 'APIError', data: { message: '[1211][模型不存在]' } },
        },
        parts: [],
      },
    ]) as Array<{ type: string; message: { content: Array<{ type: string; text?: string }> } }>;
    const errorEntry = out.find((m) => m.type === 'assistant');
    assert.ok(errorEntry, 'an error entry must be present for a failed turn');
    const text = errorEntry.message.content[0].text ?? '';
    assert.match(text, /APIError/);
    assert.match(text, /模型不存在/);
  });

  it('emits no error entry for clean messages', () => {
    const out = opencodeMessagesToSessionMessages([
      {
        info: { id: 'm2', role: 'assistant' },
        parts: [{ id: 'p1', type: 'text', messageID: 'm2', text: 'ok' }],
      },
    ]) as Array<{ message: { content: Array<{ type: string; text?: string }> } }>;
    const allText = out.flatMap((m) => m.message.content.map((b) => b.text ?? '')).join(' ');
    assert.ok(!allText.includes('后端错误'));
  });
});
