import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  opencodeMessagesToSessionMessages,
  pairTaskToolCallsWithChildren,
  type OpencodeRestMessage,
} from './opencode-transcript.js';

describe('opencodeMessagesToSessionMessages', () => {
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
