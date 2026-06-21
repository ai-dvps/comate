import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { reconstructSubagentState } from './subagent-loader.js';

describe('reconstructSubagentState', () => {
  it('reconstructs text, thinking, tool_use, and tool_result blocks', () => {
    const messages: SessionMessage[] = [
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'file contents' }],
              is_error: false,
            },
          ],
        },
        timestamp: '2026-06-19T10:00:00.000Z',
      } as unknown as SessionMessage,
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'planning' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        timestamp: '2026-06-19T10:00:01.000Z',
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages, 'Test agent');
    assert.ok(state);
    assert.strictEqual(state!.parentToolUseId, 'tool-123');
    assert.strictEqual(state!.description, 'Test agent');
    assert.strictEqual(state!.state, 'completed');
    assert.strictEqual(state!.messages.length, 2);
    assert.strictEqual(state!.toolCount, 1);
    assert.strictEqual(state!.progressHint, 'Bash: {"command":"ls"}');
    assert.strictEqual(state!.messages[1].parts.length, 3);
  });

  it('marks a result-finalized transcript as completed or error', () => {
    const messages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        timestamp: '2026-06-19T10:00:00.000Z',
      } as unknown as SessionMessage,
      {
        type: 'result',
        uuid: 'r1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { is_error: true },
        timestamp: '2026-06-19T10:00:01.000Z',
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages);
    assert.ok(state);
    assert.strictEqual(state!.state, 'error');
    assert.ok(typeof state!.endTime === 'number');
  });

  it('marks a transcript ending on a user error as error', () => {
    const messages: SessionMessage[] = [
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'denied',
              is_error: true,
            },
          ],
        },
        timestamp: '2026-06-19T10:00:00.000Z',
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages);
    assert.ok(state);
    assert.strictEqual(state!.state, 'error');
  });

  it('returns null when no displayable messages remain', () => {
    const state = reconstructSubagentState('tool-123', []);
    assert.strictEqual(state, null);
  });

  it('skips malformed content blocks and reconstructs the rest', () => {
    const messages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'valid' },
            { type: 'unknown_fancy_block', data: 123 },
            null,
          ],
        },
        timestamp: '2026-06-19T10:00:00.000Z',
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages);
    assert.ok(state);
    assert.strictEqual(state!.messages[0].parts.length, 1);
    assert.strictEqual(state!.messages[0].parts[0].type, 'text');
  });

  it('uses fallback timestamps when SDK messages omit timestamps', () => {
    const messages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      } as unknown as SessionMessage,
      {
        type: 'result',
        uuid: 'r1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { is_error: false },
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages, 'Test agent', {
      fallbackStartTime: 1000,
      fallbackEndTime: 9000,
    });
    assert.ok(state);
    assert.strictEqual(state!.startTime, 1000);
    assert.strictEqual(state!.endTime, 9000);
  });

  it('prefers SDK timestamps over fallback timestamps', () => {
    const messages: SessionMessage[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        timestamp: '2026-06-19T10:00:02.000Z',
      } as unknown as SessionMessage,
      {
        type: 'result',
        uuid: 'r1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { is_error: false },
        timestamp: '2026-06-19T10:00:10.000Z',
      } as unknown as SessionMessage,
    ];

    const state = reconstructSubagentState('tool-123', messages, 'Test agent', {
      fallbackStartTime: 1000,
      fallbackEndTime: 9000,
    });
    assert.ok(state);
    assert.strictEqual(state!.startTime, Date.parse('2026-06-19T10:00:02.000Z'));
    assert.strictEqual(state!.endTime, Date.parse('2026-06-19T10:00:10.000Z'));
  });
});