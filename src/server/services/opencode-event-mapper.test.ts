import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpencodeMapperState,
  mapOpencodeEvent,
  mapToolName,
} from './opencode-event-mapper.js';

const textPart = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  type: 'text',
  messageID: 'm1',
  text: '',
  ...over,
});

describe('mapToolName', () => {
  it('maps known opencode tools to claude display names', () => {
    assert.equal(mapToolName('bash'), 'Bash');
    assert.equal(mapToolName('todowrite'), 'TodoWrite');
    assert.equal(mapToolName('question'), 'AskUserQuestion');
  });

  it('capitalizes unknown tools', () => {
    assert.equal(mapToolName('custom_tool'), 'Custom_tool');
  });
});

describe('text streaming', () => {
  it('emits message_start + content_block_start + delta on first text update', () => {
    const state = createOpencodeMapperState();
    const out = mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ text: 'he' }) } },
      state,
    );
    const types = out.map((m) => (m as { type: string; event?: { type: string } }).event?.type ?? m.type);
    assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta']);
  });

  it('streams suffixes on subsequent updates without re-starting', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ text: 'he' }) } },
      state,
    );
    const out = mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ text: 'hello' }) } },
      state,
    );
    assert.equal(out.length, 1);
    const delta = (out[0] as { event: { delta: { text: string } } }).event.delta;
    assert.equal(delta.text, 'llo');
  });

  it('maps part.delta events with the right delta type for reasoning', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { id: 'r1', type: 'reasoning', messageID: 'm1', text: '' } } },
      state,
    );
    const out = mapOpencodeEvent(
      { type: 'message.part.delta', properties: { partID: 'r1', messageID: 'm1', field: 'text', delta: 'hmm' } },
      state,
    );
    const delta = (out[out.length - 1] as { event: { delta: { type: string } } }).event.delta;
    assert.equal(delta.type, 'thinking_delta');
  });
});

describe('tool parts', () => {
  it('emits a complete tool_use block with input at running', () => {
    const state = createOpencodeMapperState();
    const out = mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't1',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-1',
            tool: 'write',
            state: { status: 'running', input: { filePath: '/tmp/a' } },
          },
        },
      },
      state,
    );
    const start = out.find(
      (m) => (m as { event?: { type: string } }).event?.type === 'content_block_start',
    ) as { event: { content_block: { type: string; name: string; input: unknown } } };
    assert.equal(start.event.content_block.name, 'Write');
    assert.deepEqual(start.event.content_block.input, { filePath: '/tmp/a' });
  });

  it('emits a user tool_result on completed, is_error on error', () => {
    const state = createOpencodeMapperState();
    const completed = mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't2',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-2',
            tool: 'bash',
            state: { status: 'completed', input: {}, output: 'ok' },
          },
        },
      },
      state,
    );
    const result = completed[0] as { type: string; message: { content: Array<{ type: string; is_error: boolean; content: string }> } };
    assert.equal(result.type, 'user');
    assert.equal(result.message.content[0].type, 'tool_result');
    assert.equal(result.message.content[0].is_error, false);

    const errored = mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't3',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-3',
            tool: 'read',
            state: { status: 'error', input: {}, error: 'ENOENT' },
          },
        },
      },
      state,
    );
    const errResult = errored[0] as { message: { content: Array<{ is_error: boolean; content: string }> } };
    assert.equal(errResult.message.content[0].is_error, true);
    assert.equal(errResult.message.content[0].content, 'ENOENT');
  });

  it('does not double-emit a tool_result for repeated completed updates', () => {
    const state = createOpencodeMapperState();
    const part = {
      id: 't4',
      type: 'tool',
      messageID: 'm1',
      callID: 'call-4',
      tool: 'bash',
      state: { status: 'completed', input: {}, output: 'ok' },
    };
    mapOpencodeEvent({ type: 'message.part.updated', properties: { part } }, state);
    const second = mapOpencodeEvent({ type: 'message.part.updated', properties: { part } }, state);
    assert.equal(second.length, 0);
  });
});

describe('todos and lifecycle', () => {
  it('maps todo.updated to task_started + task_updated system messages', () => {
    const state = createOpencodeMapperState();
    const out = mapOpencodeEvent(
      {
        type: 'todo.updated',
        properties: { todos: [{ id: 'td1', content: 'do thing', status: 'in_progress' }] },
      },
      state,
    );
    const subtypes = out.map((m) => (m as { subtype?: string }).subtype);
    assert.deepEqual(subtypes, ['task_started', 'task_updated']);
    const patch = (out[1] as { patch: { status: string } }).patch;
    assert.equal(patch.status, 'in_progress');
  });

  it('maps session.idle to a success result carrying usage', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', tokens: { input: 10, output: 20 } } } },
      state,
    );
    const out = mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    ) as Array<{ type: string; subtype: string; is_error: boolean; usage: { input_tokens: number; output_tokens: number } }>;
    assert.equal(out[0].type, 'result');
    assert.equal(out[0].subtype, 'success');
    assert.equal(out[0].is_error, false);
    assert.equal(out[0].usage.input_tokens, 10);
    assert.equal(out[0].usage.output_tokens, 20);
  });

  it('maps session.error to an error result', () => {
    const state = createOpencodeMapperState();
    const out = mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'boom' } } } },
      state,
    ) as Array<{ subtype: string; is_error: boolean; errors: string[] }>;
    assert.equal(out[0].subtype, 'error_during_execution');
    assert.equal(out[0].is_error, true);
    assert.deepEqual(out[0].errors, ['boom']);
  });

  it('ignores non-mapped events', () => {
    const state = createOpencodeMapperState();
    assert.deepEqual(mapOpencodeEvent({ type: 'server.heartbeat', properties: {} }, state), []);
    assert.deepEqual(mapOpencodeEvent({ type: 'permission.asked', properties: {} }, state), []);
  });
});
