import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Response } from 'express';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SseEmitter } from './sse-emitter.js';
import type { SseEvent } from '../types/message.js';

describe('SseEmitter rate limit', { concurrency: false }, () => {
  it('forwards rate_limit_event as rate_limit plus an error_note', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        errorCode: 'credits_required',
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: true,
      },
      uuid: 'uuid-1',
      session_id: 's1',
    } as unknown as SDKMessage);

    const rateLimit = events.find((e) => e.type === 'rate_limit');
    assert.ok(rateLimit, 'expected a rate_limit event');
    assert.strictEqual(rateLimit.type, 'rate_limit');
    assert.strictEqual(rateLimit.errorCode, 'credits_required');
    assert.strictEqual(rateLimit.canUserPurchaseCredits, true);
    assert.strictEqual(rateLimit.hasChargeableSavedPaymentMethod, true);
    assert.ok(
      events.some((e) => e.type === 'error_note'),
      'expected an error_note for backward compatibility',
    );
  });

  it('uses throughput copy when no credit fields are present', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
      },
      uuid: 'uuid-2',
      session_id: 's1',
    } as unknown as SDKMessage);

    const rateLimit = events.find((e) => e.type === 'rate_limit');
    assert.ok(rateLimit);
    assert.strictEqual(rateLimit.errorCode, undefined);
    assert.strictEqual(rateLimit.rateLimitType, 'five_hour');
    const note = events.find((e) => e.type === 'error_note');
    assert.ok(note && note.type === 'error_note');
    assert.ok(note.text.includes('Rate limit reached'));
  });
});

describe('SseEmitter tool_use_meta', { concurrency: false }, () => {
  it('emits tool_use_meta from content_block_start block-level meta', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-1' },
      },
    } as unknown as SDKMessage);
    emitter.handle({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tu-1',
          name: 'mcp__server__fetch',
          tool_use_meta: { display_name: 'Web Fetch', icon_url: 'https://example.com/icon.png' },
        },
      },
    } as unknown as SDKMessage);

    const metaEvent = events.find((e) => e.type === 'tool_use_meta');
    assert.ok(metaEvent, 'expected a tool_use_meta event');
    assert.strictEqual(metaEvent.toolUseId, 'tu-1');
    assert.strictEqual(metaEvent.meta.displayName, 'Web Fetch');
    assert.strictEqual(metaEvent.meta.iconUrl, 'https://example.com/icon.png');
  });

  it('emits tool_use_meta from final assistant message top-level array', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'mcp__server__read', input: { path: '/' } },
        ],
        tool_use_meta: [{ display_name: 'Read', icon_url: 'https://example.com/read.png' }],
      },
    } as unknown as SDKMessage);

    const metaEvent = events.find((e) => e.type === 'tool_use_meta');
    assert.ok(metaEvent, 'expected a tool_use_meta event');
    assert.strictEqual(metaEvent.toolUseId, 'tu-1');
    assert.strictEqual(metaEvent.meta.displayName, 'Read');
    assert.strictEqual(metaEvent.meta.iconUrl, 'https://example.com/read.png');
  });

  it('prefers top-level meta over block-level meta when both are present', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'mcp__server__read',
            input: { path: '/' },
            tool_use_meta: { display_name: 'Block Name' },
          },
        ],
        tool_use_meta: [{ display_name: 'Top Name', icon_url: 'https://example.com/top.png' }],
      },
    } as unknown as SDKMessage);

    const metaEvent = events.find((e) => e.type === 'tool_use_meta');
    assert.ok(metaEvent);
    assert.strictEqual(metaEvent.meta.displayName, 'Top Name');
    assert.strictEqual(metaEvent.meta.iconUrl, 'https://example.com/top.png');
  });

  it('skips tool_use_meta when no meta fields are present', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
      },
    } as unknown as SDKMessage);

    assert.ok(!events.some((e) => e.type === 'tool_use_meta'));
  });
});

describe('SseEmitter pending approval', { concurrency: false }, () => {
  it('includes denialReason when provided', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.emitPendingApproval(
      'req-1',
      'Bash',
      'tu-1',
      { command: 'rm -rf /' },
      'Dangerous command',
      'This will delete everything',
      undefined,
      undefined,
      'safetyCheck',
    );

    const event = events.find((e) => e.type === 'pending_approval');
    assert.ok(event);
    assert.strictEqual((event as { denialReason?: string }).denialReason, 'safetyCheck');
  });

  it('omits denialReason when not provided', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.emitPendingApproval('req-1', 'Bash', 'tu-1', { command: 'ls' });

    const event = events.find((e) => e.type === 'pending_approval');
    assert.ok(event);
    assert.strictEqual((event as { denialReason?: string }).denialReason, undefined);
  });
});

describe('SseEmitter result metadata', { concurrency: false }, () => {
  it('forwards stop_reason, terminal_reason, and origin on result events', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      origin: 'primary',
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: {},
      uuid: 'uuid-1',
      session_id: 's1',
    } as unknown as SDKMessage);

    const result = events.find((e) => e.type === 'result');
    assert.ok(result);
    assert.strictEqual((result as { stopReason?: string }).stopReason, 'end_turn');
    assert.strictEqual((result as { terminalReason?: string }).terminalReason, 'completed');
    assert.strictEqual((result as { origin?: string }).origin, 'primary');
  });

  it('omits metadata fields when the SDK does not provide them', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: {},
      uuid: 'uuid-2',
      session_id: 's1',
    } as unknown as SDKMessage);

    const result = events.find((e) => e.type === 'result');
    assert.ok(result);
    assert.strictEqual((result as { stopReason?: string | null }).stopReason, null);
    assert.strictEqual((result as { terminalReason?: string }).terminalReason, undefined);
    assert.strictEqual((result as { origin?: string }).origin, undefined);
  });
});

describe('SseEmitter workflow events', { concurrency: false }, () => {
  it('emits workflow_start when a Workflow tool_result reports async_launched', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      tools: [],
      session_id: 'session-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-wf-1', name: 'Workflow', input: { name: 'deep-research', args: 'test' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-wf-1', content: 'Workflow launched', is_error: false }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskId: 'task-1',
        taskType: 'local_workflow',
        workflowName: 'deep-research',
        runId: 'wf_run-1',
      },
    } as unknown as SDKMessage);

    const start = events.find((e) => e.type === 'workflow_start');
    assert.ok(start, 'expected workflow_start');
    assert.strictEqual(start.runId, 'wf_run-1');
    assert.strictEqual(start.sessionId, 'session-1');
    assert.strictEqual(start.toolUseId, 'tu-wf-1');
    assert.strictEqual(start.workflowName, 'deep-research');
  });

  it('emits workflow_update and workflow_done for tracked workflow task events', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      tools: [],
      session_id: 'session-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-wf-1', name: 'Workflow', input: { name: 'deep-research' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-wf-1', content: 'Workflow launched', is_error: false }],
      },
      toolUseResult: { status: 'async_launched', taskId: 'task-1', runId: 'wf_run-1' },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'completed',
    } as unknown as SDKMessage);

    const updates = events.filter((e) => e.type === 'workflow_update');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].runId, 'wf_run-1');

    const done = events.find((e) => e.type === 'workflow_done');
    assert.ok(done);
    assert.strictEqual(done.runId, 'wf_run-1');
    assert.strictEqual(done.status, 'completed');
  });
});

describe('SseEmitter api_retry', { concurrency: false }, () => {
  it('forwards api_retry system messages as api_retry events', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error_status: 529,
    } as unknown as SDKMessage);

    const retry = events.find((e) => e.type === 'api_retry');
    assert.ok(retry, 'expected an api_retry event');
    assert.strictEqual(retry.attempt, 1);
    assert.strictEqual(retry.maxRetries, 3);
    assert.strictEqual(retry.retryDelayMs, 1000);
    assert.strictEqual(retry.errorStatus, 529);
  });

  it('tolerates missing optional api_retry fields', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
    } as unknown as SDKMessage);

    const retry = events.find((e) => e.type === 'api_retry');
    assert.ok(retry);
    assert.strictEqual(retry.attempt, 2);
    assert.strictEqual(retry.maxRetries, 0);
    assert.strictEqual(retry.retryDelayMs, 0);
    assert.strictEqual(retry.errorStatus, null);
  });
});

describe('SseEmitter diagnostics', { concurrency: false }, () => {
  it('does not write high-frequency text deltas to console', () => {
    const originalLog = console.log;
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      const emitter = new SseEmitter({
        write: () => true,
      } as unknown as Response);

      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1' },
        },
      } as unknown as SDKMessage);
      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
      } as unknown as SDKMessage);

      calls.length = 0;

      emitter.handle({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      } as unknown as SDKMessage);

      assert.deepStrictEqual(calls, []);
    } finally {
      console.log = originalLog;
    }
  });
});

describe('SseEmitter async subagent lifecycle', { concurrency: false }, () => {
  it('does not emit subagent_done on an async_launched Agent tool_result', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      tools: [],
      session_id: 'session-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { prompt: 'Research async subagents' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-agent-1', content: 'Async agent launched successfully', is_error: false }],
      },
      toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
    } as unknown as SDKMessage);

    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.ok(toolResult, 'expected tool_result event');
    assert.strictEqual(toolResult.toolUseId, 'tu-agent-1');
    assert.ok(
      !(toolResult as Record<string, unknown>).toolUseResult ||
        ((toolResult as Record<string, unknown>).toolUseResult as Record<string, unknown>).status === 'async_launched',
      'tool_result should preserve async metadata',
    );
    assert.ok(!events.some((e) => e.type === 'subagent_done'), 'subagent_done should not fire on async launch metadata');
  });

  it('emits subagent_done once when the subagent transcript finishes', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      tools: [],
      session_id: 'session-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { prompt: 'Research async subagents' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-agent-1', content: 'Async agent launched successfully', is_error: false }],
      },
      toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
    } as unknown as SDKMessage);

    // Simulate subagent starting and producing output.
    emitter.startSubagent('tu-agent-1', 'Research async subagents');

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-subagent-1',
        content: [{ type: 'text', text: 'Subagent output' }],
      },
      origin: 'subagent',
      parent_tool_use_id: 'tu-agent-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      origin: 'subagent',
      parent_tool_use_id: 'tu-agent-1',
    } as unknown as SDKMessage);

    const dones = events.filter((e) => e.type === 'subagent_done');
    assert.strictEqual(dones.length, 1, 'expected exactly one subagent_done');
    assert.strictEqual(dones[0].parentToolUseId, 'tu-agent-1');
  });

  it('still finalizes a synchronous Agent tool_result', () => {
    const events: SseEvent[] = [];
    const emitter = new SseEmitter(null, (_id, event) => events.push(event));

    emitter.handle({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      tools: [],
      session_id: 'session-1',
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { prompt: 'Quick sync task' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-agent-1', content: 'Sync result', is_error: false }],
      },
    } as unknown as SDKMessage);

    const dones = events.filter((e) => e.type === 'subagent_done');
    assert.strictEqual(dones.length, 1, 'sync Agent tool_result should finalize subagent');
    assert.strictEqual(dones[0].parentToolUseId, 'tu-agent-1');
  });
});