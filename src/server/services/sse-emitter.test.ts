import '../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import type { Response } from 'express';
import type { SDKMessage, Query, Options } from '@anthropic-ai/claude-agent-sdk';
import { SseEmitter } from './sse-emitter.js';
import { SessionRuntime } from './session-runtime.js';
import type { SdkClient } from './sdk-client.js';
import type { SseEvent, TaskSignal } from '../types/message.js';

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

describe('SseEmitter task signals', { concurrency: false }, () => {
  function createEmitter() {
    const events: SseEvent[] = [];
    const signals: TaskSignal[] = [];
    const emitter = new SseEmitter(
      null,
      (_id, event) => events.push(event),
      (signal) => signals.push(signal),
    );
    return { emitter, events, signals };
  }

  it('emits a started signal carrying raw fields on task_started; the wire event is unchanged', () => {
    const { emitter, events, signals } = createEmitter();

    emitter.handle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      description: 'background job',
      tool_use_id: 'tu-1',
      subagent_type: 'Explore',
      skip_transcript: true,
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, [
      {
        kind: 'started',
        taskId: 'task-1',
        toolUseId: 'tu-1',
        subagentType: 'Explore',
        skipTranscript: true,
      },
    ]);
    const wire = events.find((e) => e.type === 'task_started');
    assert.deepStrictEqual(wire, {
      type: 'task_started',
      taskId: 'task-1',
      description: 'background job',
    });
  });

  it('emits started with toolUseId undefined when task_started carries no tool_use_id', () => {
    const { emitter, signals } = createEmitter();

    emitter.handle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-2',
      description: 'uncorrelated',
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, [
      { kind: 'started', taskId: 'task-2', skipTranscript: false },
    ]);
  });

  it('emits backgroundedPatch when task_updated patch.is_backgrounded is true', () => {
    const { emitter, signals } = createEmitter();

    emitter.handle({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { is_backgrounded: true },
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, [{ kind: 'backgroundedPatch', taskId: 'task-1' }]);
  });

  it('emits terminal for terminal task_updated statuses (completed/failed/killed)', () => {
    const { emitter, events, signals } = createEmitter();

    for (const status of ['completed', 'failed', 'killed']) {
      emitter.handle({
        type: 'system',
        subtype: 'task_updated',
        task_id: `task-${status}`,
        patch: { status },
      } as unknown as SDKMessage);
    }

    assert.deepStrictEqual(signals, [
      { kind: 'terminal', taskId: 'task-completed' },
      { kind: 'terminal', taskId: 'task-failed' },
      { kind: 'terminal', taskId: 'task-killed' },
    ]);
    const updates = events.filter((e) => e.type === 'task_updated');
    assert.strictEqual(updates.length, 3, 'wire task_updated events are unchanged');
  });

  it('emits no signal for a non-terminal task_updated status', () => {
    const { emitter, signals } = createEmitter();

    emitter.handle({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { status: 'in_progress', description: 'working' },
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, []);
  });

  it('emits terminal for task_notification completed/failed/stopped', () => {
    const { emitter, signals } = createEmitter();

    for (const status of ['completed', 'failed', 'stopped']) {
      emitter.handle({
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${status}`,
        status,
      } as unknown as SDKMessage);
    }

    assert.deepStrictEqual(signals, [
      { kind: 'terminal', taskId: 'task-completed' },
      { kind: 'terminal', taskId: 'task-failed' },
      { kind: 'terminal', taskId: 'task-stopped' },
    ]);
  });

  it('emits no signal for a non-terminal task_notification status', () => {
    const { emitter, events, signals } = createEmitter();

    emitter.handle({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'running',
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, []);
    assert.ok(events.some((e) => e.type === 'task_updated'), 'wire event still sent');
  });

  it('emits asyncLaunched for an active sub-agent whose tool result is async_launched', () => {
    const { emitter, signals } = createEmitter();

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { prompt: 'bg work' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-agent-1', content: 'launched', is_error: false }],
      },
      toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, [
      { kind: 'asyncLaunched', toolUseId: 'tu-agent-1', agentId: 'agent-1' },
    ]);
  });

  it('emits bashBackgrounded when the message-level toolUseResult carries a backgroundTaskId string', () => {
    const { emitter, signals } = createEmitter();

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-bash-1', content: 'running in background', is_error: false }],
      },
      toolUseResult: { status: 'backgrounded', backgroundTaskId: 'bash-task-9' },
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, [
      { kind: 'bashBackgrounded', toolUseId: 'tu-bash-1', taskId: 'bash-task-9' },
    ]);
  });

  it('emits no signal for a workflow async launch, and still sends workflow_start', () => {
    const { emitter, events, signals } = createEmitter();

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

    assert.deepStrictEqual(signals, [], 'workflow async launches emit no signal in v1');
    assert.ok(events.some((e) => e.type === 'workflow_start'), 'workflow_start is still sent');
  });

  it('emits no signal when a synchronous sub-agent finalizes', () => {
    const { emitter, events, signals } = createEmitter();

    emitter.handle({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { prompt: 'sync' } }],
      },
    } as unknown as SDKMessage);

    emitter.handle({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-agent-1', content: 'Sync result', is_error: false }],
      },
    } as unknown as SDKMessage);

    assert.deepStrictEqual(signals, []);
    assert.strictEqual(
      events.filter((e) => e.type === 'subagent_done').length,
      1,
      'the existing finalizeSubagent path is unchanged',
    );
  });

  it('tolerates malformed raw fields: no signal and no throw', () => {
    const { emitter, signals } = createEmitter();

    assert.doesNotThrow(() => {
      emitter.handle({
        type: 'system',
        subtype: 'task_started',
        task_id: 42,
        tool_use_id: 'tu-1',
      } as unknown as SDKMessage);

      emitter.handle({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
      } as unknown as SDKMessage);

      emitter.handle({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-1',
        patch: { is_backgrounded: 1, status: 7 },
      } as unknown as SDKMessage);

      emitter.handle({
        type: 'system',
        subtype: 'task_notification',
        task_id: 99,
        status: 'completed',
      } as unknown as SDKMessage);

      emitter.handle({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-bash-1', content: 'x', is_error: false }],
        },
        toolUseResult: { backgroundTaskId: 12345 },
      } as unknown as SDKMessage);

      emitter.handle({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'x', is_error: false }],
        },
        toolUseResult: { backgroundTaskId: 'bash-task-1' },
      } as unknown as SDKMessage);
    });

    assert.deepStrictEqual(signals, []);
  });
});

describe('SseEmitter + SessionRuntime task-signal integration', { concurrency: false }, () => {
  let runtime: SessionRuntime | undefined;

  afterEach(async () => {
    if (runtime && !runtime.isClosed()) {
      await runtime.close();
    }
    runtime = undefined;
  });

  function createMockSdkClient(messages: SDKMessage[]): SdkClient {
    const mockQuery = {
      interrupt: () => Promise.resolve(),
      close: () => {},
    } as unknown as Query;

    const messageGen = (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();

    return {
      createStreamingQuery: () => ({
        query: mockQuery,
        messages: messageGen,
      }),
    } as unknown as SdkClient;
  }

  it('task_started + async_launched + result + task_notification yields the {true} → count-edge → {false} edge sequence', async () => {
    const events: SseEvent[] = [];
    const messages: SDKMessage[] = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tu-1',
        description: 'background agent',
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Agent', input: { prompt: 'bg' } }],
        },
      } as unknown as SDKMessage,
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'launched', is_error: false }],
        },
        toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
      } as unknown as SDKMessage,
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
      } as unknown as SDKMessage,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
      } as unknown as SDKMessage,
    ];

    runtime = SessionRuntime.open(
      's1',
      'ws1',
      'nonce',
      {} as Options,
      createMockSdkClient(messages),
      (_id, event) => events.push(event),
    );

    await new Promise((r) => setTimeout(r, 100));

    const processing = events.filter(
      (e): e is Extract<SseEvent, { type: 'session_processing' }> => e.type === 'session_processing',
    );
    assert.deepStrictEqual(processing, [
      { type: 'session_processing', processing: true, backgroundTaskCount: 0 },
      // Count-only edge: the task confirmation flips the count while the
      // turn keeps the processing boolean true.
      { type: 'session_processing', processing: true, backgroundTaskCount: 1 },
      { type: 'session_processing', processing: false, backgroundTaskCount: 0 },
    ]);

    // The foreground turn's result must arrive before the settle edge: the
    // confirmed background task held the session active past the turn result.
    const resultIdx = events.findIndex((e) => e.type === 'result');
    const settleIdx = events.indexOf(processing[2]);
    assert.ok(resultIdx !== -1, 'expected a result wire event');
    assert.ok(resultIdx < settleIdx, 'the turn result precedes the settle edge');
  });
});
