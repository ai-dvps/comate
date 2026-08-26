import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpencodeMapperState,
  mapOpencodeEvent,
  mapToolName,
} from './opencode-event-mapper.js';
import { SseEmitter } from './sse-emitter.js';
import type { SseEvent } from '../types/message.js';

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
  it('waits for running input before emitting a tool through the browser SSE boundary', () => {
    const state = createOpencodeMapperState();
    const pending = mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 't1',
            type: 'tool',
            messageID: 'm1',
            callID: 'call-1',
            tool: 'write',
            state: { status: 'pending', input: {} },
          },
        },
      },
      state,
    );
    assert.deepEqual(pending, []);

    const running = mapOpencodeEvent(
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
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));
    for (const message of running) emitter.handle(message);

    const done = events.find((event) => event.type === 'tool_use_done');
    assert.ok(done && done.type === 'tool_use_done');
    assert.deepEqual(done.input, { filePath: '/tmp/a' });
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

describe('message role filtering', () => {
  it('does not render user message text as assistant content', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm-user', role: 'user', sessionID: 's1' } } },
      state,
    );
    const out = mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ id: 'p-user', messageID: 'm-user', text: '今天天气如何' }) } },
      state,
    );
    assert.deepEqual(out, [], 'user text part must not emit assistant stream events');
  });

  it('ignores deltas on user message parts', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm-user', role: 'user', sessionID: 's1' } } },
      state,
    );
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ id: 'p-user', messageID: 'm-user', text: '' }) } },
      state,
    );
    const out = mapOpencodeEvent(
      { type: 'message.part.delta', properties: { partID: 'p-user', messageID: 'm-user', field: 'text', delta: '今天天气如何' } },
      state,
    );
    assert.deepEqual(out, [], 'user text delta must not emit assistant stream events');
  });

  it('still renders assistant text after a user message', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm-user', role: 'user', sessionID: 's1' } } },
      state,
    );
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ id: 'p-user', messageID: 'm-user', text: 'user prompt' }) } },
      state,
    );
    const startOut = mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm-assistant', role: 'assistant', sessionID: 's1' } } },
      state,
    );
    assert.deepEqual(
      startOut.map((m) => (m as { type: string; event?: { type: string } }).event?.type ?? m.type),
      ['message_start'],
    );
    const out = mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: textPart({ id: 'p-assistant', messageID: 'm-assistant', text: 'assistant reply' }) } },
      state,
    );
    const types = out.map((m) => (m as { type: string; event?: { type: string } }).event?.type ?? m.type);
    assert.deepEqual(types, ['content_block_start', 'content_block_delta']);
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

  it('completes an open reasoning part before session.idle finishes the turn', () => {
    const state = createOpencodeMapperState();
    const sdkMessages = [
      ...mapOpencodeEvent(
        { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } },
        state,
      ),
      ...mapOpencodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'r1',
              type: 'reasoning',
              messageID: 'm1',
              text: 'finished reasoning',
              time: { start: 1 },
            },
          },
        },
        state,
      ),
      ...mapOpencodeEvent(
        { type: 'session.idle', properties: { sessionID: 's1' } },
        state,
      ),
    ];

    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));
    for (const message of sdkMessages) emitter.handle(message);

    assert.deepEqual(
      events.map((event) => event.type),
      ['assistant_start', 'thinking_start', 'thinking_delta', 'thinking_done', 'assistant_done', 'result'],
    );

    for (const message of mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    )) {
      emitter.handle(message);
    }
    assert.equal(
      events.filter((event) => event.type === 'thinking_done').length,
      1,
      'repeated idle events must not complete the same reasoning part twice',
    );
  });

  it('maps session.error to an error result', () => {
    const state = createOpencodeMapperState();
    const sdkMessages = [
      ...mapOpencodeEvent(
        { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } },
        state,
      ),
      ...mapOpencodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            part: { id: 'r1', type: 'reasoning', messageID: 'm1', text: 'partial reasoning' },
          },
        },
        state,
      ),
      ...mapOpencodeEvent(
        { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'boom' } } } },
        state,
      ),
    ];
    const result = sdkMessages.find((message) => message.type === 'result') as {
      subtype: string;
      is_error: boolean;
      errors: string[];
    };
    assert.equal(result.subtype, 'error_during_execution');
    assert.equal(result.is_error, true);
    assert.deepEqual(result.errors, ['boom']);

    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));
    for (const message of sdkMessages) emitter.handle(message);
    assert.deepEqual(
      events.map((event) => event.type),
      ['assistant_start', 'thinking_start', 'thinking_delta', 'thinking_done', 'assistant_done', 'result', 'error_note'],
    );
  });

  it('ignores non-mapped events', () => {
    const state = createOpencodeMapperState();
    assert.deepEqual(mapOpencodeEvent({ type: 'server.heartbeat', properties: {} }, state), []);
    assert.deepEqual(mapOpencodeEvent({ type: 'permission.asked', properties: {} }, state), []);
  });
});

describe('error turn handling (silent-error fix)', () => {
  it('keeps context overflow recoverable while OpenCode auto-compacts', () => {
    const state = createOpencodeMapperState();
    const overflow = mapOpencodeEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: 's1',
          error: {
            name: 'ContextOverflowError',
            data: { message: 'Requested token count exceeds the model context length' },
          },
        },
      },
      state,
    ) as Array<{ type: string; subtype?: string; status?: string }>;

    assert.deepEqual(
      overflow.map((message) => ({ type: message.type, subtype: message.subtype, status: message.status })),
      [{ type: 'system', subtype: 'status', status: 'compacting' }],
      'a recoverable overflow should show compaction progress, not a fatal result',
    );

    const compacted = mapOpencodeEvent(
      { type: 'session.compacted', properties: { sessionID: 's1' } },
      state,
    ) as Array<{ type: string; subtype?: string; status?: null }>;
    assert.deepEqual(
      compacted.map((message) => ({ type: message.type, subtype: message.subtype, status: message.status })),
      [
        { type: 'system', subtype: 'status', status: null },
        { type: 'system', subtype: 'compact_boundary', status: undefined },
      ],
    );

    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));
    for (const message of [...overflow, ...compacted]) emitter.handle(message as never);
    assert.deepEqual(events, [
      { type: 'compact_status', active: true },
      { type: 'compact_status', active: false },
      { type: 'compact_boundary' },
    ]);

    mapOpencodeEvent(
      { type: 'message.updated', properties: { info: { id: 'm-retry', role: 'assistant' } } },
      state,
    );
    const idle = mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    ) as Array<{ type: string; subtype: string; is_error: boolean }>;
    assert.equal(idle.at(-1)?.subtype, 'success');
    assert.equal(idle.at(-1)?.is_error, false);
  });

  it('surfaces context overflow when compaction cannot recover', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: 's1',
          error: {
            name: 'ContextOverflowError',
            data: { message: 'Session too large to compact' },
          },
        },
      },
      state,
    );

    const idle = mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    ) as Array<{ type: string; subtype?: string; is_error?: boolean; errors?: string[] }>;
    const result = idle.find((message) => message.type === 'result');
    assert.equal(result?.subtype, 'error_during_execution');
    assert.equal(result?.is_error, true);
    assert.deepEqual(result?.errors, ['Session too large to compact']);
  });

  it('does not emit duplicate compacting status for repeated context overflow errors', () => {
    const state = createOpencodeMapperState();
    const overflow = {
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'ContextOverflowError', data: { message: 'still too large' } },
      },
    };
    assert.equal(mapOpencodeEvent(overflow, state).length, 1);
    assert.deepEqual(mapOpencodeEvent(overflow, state), []);

    const idle = mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    ) as Array<{ type: string; errors?: string[] }>;
    assert.deepEqual(idle.find((message) => message.type === 'result')?.errors, ['still too large']);
  });

  it('clears compacting status before a different fatal session error', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'ContextOverflowError', data: { message: 'too large' } },
      },
    }, state);

    const fatal = mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'provider unavailable' } } } },
      state,
    ) as Array<{ type: string; subtype?: string; status?: null; errors?: string[] }>;
    assert.deepEqual(
      fatal.map((message) => ({ type: message.type, subtype: message.subtype, status: message.status, errors: message.errors })),
      [
        { type: 'system', subtype: 'status', status: null, errors: undefined },
        { type: 'result', subtype: 'error_during_execution', status: undefined, errors: ['provider unavailable'] },
      ],
    );
    assert.deepEqual(mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    ), []);
  });

  it('does not let an unrelated compaction turn a fatal error into success', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'boom' } } } },
      state,
    );

    mapOpencodeEvent(
      { type: 'session.compacted', properties: { sessionID: 's1' } },
      state,
    );

    const idle = mapOpencodeEvent(
      { type: 'session.idle', properties: { sessionID: 's1' } },
      state,
    );
    assert.deepEqual(idle, [], 'compaction must not erase an unrelated fatal-error state');
  });

  it('suppresses success results for idles that follow a session.error in the same turn', () => {
    const state = createOpencodeMapperState();
    const errorOut = mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'model missing' } } } },
      state,
    ) as Array<{ subtype: string; is_error: boolean }>;
    assert.equal(errorOut.length, 1);
    assert.equal(errorOut[0].subtype, 'error_during_execution');

    const idle1 = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's1' } }, state);
    const idle2 = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's1' } }, state);
    assert.deepEqual(idle1, [], 'idle after error must not emit success');
    assert.deepEqual(idle2, [], 'repeated idles after error must stay suppressed');
  });

  it('emits success again once new activity starts a fresh turn after an error', () => {
    const state = createOpencodeMapperState();
    mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'boom' } } } },
      state,
    );
    mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's1' } }, state);

    // New activity (a fresh assistant message) marks a new turn
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', messageID: 'm2', text: 'hi' } } },
      state,
    );
    const idleOut = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's1' } }, state) as Array<{
      type: string;
      subtype: string;
    }>;
    const results = idleOut.filter((message) => message.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].subtype, 'success');
  });

  it('keeps idles suppressed when the failed turn’s in-flight message still updates (same messageID)', () => {
    const state = createOpencodeMapperState();
    // In-flight turn m1 starts, then the model errors mid-stream
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', messageID: 'm1', text: 'partial' } } },
      state,
    );
    mapOpencodeEvent(
      { type: 'session.error', properties: { sessionID: 's1', error: { data: { message: 'boom' } } } },
      state,
    );
    // The failed turn's own message still updates (final state flush)
    mapOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { id: 'p1', type: 'text', messageID: 'm1', text: 'partial flush' } } },
      state,
    );
    const idle = mapOpencodeEvent({ type: 'session.idle', properties: { sessionID: 's1' } }, state);
    assert.deepEqual(idle, [], 'in-flight message updates must not clear the errored-turn flag');
  });
});
