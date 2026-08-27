import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadItem } from '../generated/codex-protocol/v2/ThreadItem.js';
import type { SseEvent } from '../types/message.js';
import { CodexEventMapper } from './codex-event-mapper.js';
import { SseEmitter } from './sse-emitter.js';

function event(message: SDKMessage): Record<string, unknown> {
  return (message as unknown as { event: Record<string, unknown> }).event;
}

describe('CodexEventMapper', () => {
  it('maps text and reasoning deltas into ordered shared content blocks', () => {
    const mapper = new CodexEventMapper('gpt-test');
    const text = mapper.map('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'text-1', delta: 'hello',
    });
    const reasoning = mapper.map('item/reasoning/summaryTextDelta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: 'thinking',
    });

    assert.deepStrictEqual(text.map((message) => event(message).type), [
      'message_start', 'content_block_start', 'content_block_delta',
    ]);
    assert.deepStrictEqual(reasoning.map((message) => event(message).type), [
      'content_block_start', 'content_block_delta',
    ]);
    assert.notStrictEqual(event(text[1]).index, event(reasoning[0]).index);
  });

  it('maps command lifecycle to one tool call and one result', () => {
    const mapper = new CodexEventMapper();
    const started = {
      type: 'commandExecution',
      id: 'cmd-1',
      pluginId: null,
      scriptPath: null,
      command: 'npm test',
      cwd: '/tmp/project',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    } as unknown as ThreadItem;
    const completed = {
      ...started,
      status: 'completed',
      aggregatedOutput: 'ok',
      exitCode: 0,
    } as unknown as ThreadItem;

    const open = mapper.map('item/started', { turnId: 'turn-1', item: started });
    const done = mapper.map('item/completed', { turnId: 'turn-1', item: completed });

    assert.deepStrictEqual(open.map((message) => event(message).type), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    ]);
    const result = done[0] as unknown as {
      type: string;
      message: { content: Array<{ tool_use_id: string; content: string; is_error: boolean }> };
    };
    assert.strictEqual(result.type, 'user');
    assert.deepStrictEqual(result.message.content[0], {
      type: 'tool_result', tool_use_id: 'cmd-1', content: 'ok', is_error: false,
    });
  });

  it('preserves Codex tool arguments through the shared SSE emitter', () => {
    const mapper = new CodexEventMapper();
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, emitted) => events.push(emitted));
    const item = {
      type: 'mcpToolCall',
      id: 'tool-1',
      server: 'demo',
      tool: 'lookup',
      status: 'inProgress',
      arguments: { query: 'hello', limit: 5 },
      result: null,
      error: null,
      appContext: null,
      durationMs: null,
    } as unknown as ThreadItem;

    for (const message of mapper.map('item/started', { turnId: 'turn-1', item })) {
      emitter.handle(message);
    }

    const done = events.find((candidate) => candidate.type === 'tool_use_done');
    assert.ok(done && done.type === 'tool_use_done');
    assert.deepStrictEqual(done.input, { query: 'hello', limit: 5 });
  });
});
