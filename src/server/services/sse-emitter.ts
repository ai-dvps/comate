import type { Response } from 'express';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SseEvent, QuestionPayload } from '../types/message.js';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { diagLog, diagWarn } from '../utils/diag-logger.js';

/**
 * Tracks the in-flight type for each SDK content-block index inside the
 * current assistant turn. We need this so `content_block_stop` knows what
 * kind of `*_done` event (if any) to emit and where the buffered input
 * lives.
 */
interface BlockState {
  type: 'text' | 'tool_use' | 'thinking' | 'unknown';
  toolUseId?: string;
  toolName?: string;
  inputBuffer?: string;
}

/**
 * Per-stream stateful SSE emitter for the chat route.
 *
 * Consumes `SDKMessage` events from the Claude Agent SDK and writes typed
 * `SseEvent` frames. State scoped to a single chat request:
 *   - `currentMessageId`: in-flight Anthropic message id (from
 *     `stream_event.message_start.message.id`, or the whole-turn
 *     `assistant` event's `message.id` when streaming was skipped).
 *   - `blockStates`: SDK-block-index → kind + tool/input scratchpad.
 *   - `seenStreamPartIndexes`: which block indices were emitted during the
 *     streaming pass — used to dedup against the whole-turn `assistant`
 *     finalizer (which always re-delivers the full content[] array).
 *   - `finalizedMessageIds`: Anthropic messageIds for which `assistant_done`
 *     has already fired. The SDK splits a single Anthropic API message
 *     across multiple whole-turn `assistant` SDKMessage frames (one per
 *     thinking/text/tool_use phase, all sharing the same `message.id`);
 *     this set prevents `assistant_done` and `assistant_start` from
 *     double-firing across those phases.
 *
 * After U2, the emitter supports a swappable Response (for reconnection)
 * and emits `id:` lines on every frame (for ring-buffer replay).
 */
export class SseEmitter {
  private res: Response | null = null;
  private currentMessageId: string | null = null;
  private assistantStartEmitted = false;
  private blockStates = new Map<number, BlockState>();
  private seenStreamPartIndexes = new Set<number>();
  private finalizedMessageIds = new Set<string>();
  private eventIndex = 0;
  private nextPartIndex = 0;
  private onEvent?: (id: number, event: SseEvent) => void;

  constructor(res: Response | null = null, onEvent?: (id: number, event: SseEvent) => void) {
    this.res = res;
    this.onEvent = onEvent;
  }

  setResponse(res: Response | null): void {
    this.res = res;
  }

  reset(): void {
    this.currentMessageId = null;
    this.assistantStartEmitted = false;
    this.blockStates.clear();
    this.seenStreamPartIndexes.clear();
    this.finalizedMessageIds.clear();
    this.eventIndex = 0;
    this.nextPartIndex = 0;
    this.activeSubagents.clear();
  }

  private activeSubagents = new Map<string, SubagentEmitter>();

  handle(msg: SDKMessage): void {
    const parentToolUseId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;

    if (parentToolUseId) {
      let emitter = this.activeSubagents.get(parentToolUseId);
      if (!emitter) {
        emitter = new SubagentEmitter(parentToolUseId, this);
        this.activeSubagents.set(parentToolUseId, emitter);
      }
      emitter.handle(msg);
      return;
    }

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.send({
            type: 'system_init',
            model: msg.model,
            tools: msg.tools,
            sessionId: msg.session_id,
          });
          return;
        }

        const taskMsg = msg as Record<string, unknown>;
        if (msg.subtype === 'task_started') {
          const taskId = typeof taskMsg.task_id === 'string' ? taskMsg.task_id : '';
          const description = typeof taskMsg.description === 'string' ? taskMsg.description : '';
          if (taskId) {
            this.send({ type: 'task_started', taskId, description });
          }
          return;
        }

        if (msg.subtype === 'task_updated') {
          const taskId = typeof taskMsg.task_id === 'string' ? taskMsg.task_id : '';
          const patch = taskMsg.patch as Record<string, unknown> | undefined;
          if (taskId) {
            this.send({
              type: 'task_updated',
              taskId,
              patch: {
                status: typeof patch?.status === 'string' ? patch.status : undefined,
                description: typeof patch?.description === 'string' ? patch.description : undefined,
                error: typeof patch?.error === 'string' ? patch.error : undefined,
              },
            });
          }
          return;
        }

        if (msg.subtype === 'task_progress') {
          const taskId = typeof taskMsg.task_id === 'string' ? taskMsg.task_id : '';
          const description = typeof taskMsg.description === 'string' ? taskMsg.description : '';
          if (taskId) {
            this.send({
              type: 'task_updated',
              taskId,
              patch: { description },
            });
          }
          return;
        }

        if (msg.subtype === 'task_notification') {
          const taskId = typeof taskMsg.task_id === 'string' ? taskMsg.task_id : '';
          const status = typeof taskMsg.status === 'string' ? taskMsg.status : '';
          if (taskId) {
            this.send({
              type: 'task_updated',
              taskId,
              patch: { status },
            });
          }
          return;
        }

        if (msg.subtype === 'compact_boundary') {
          this.send({ type: 'compact_boundary' });
          return;
        }

        if (msg.subtype === 'status') {
          const statusMsg = msg as Record<string, unknown>;
          const status = statusMsg.status;
          if (status === 'compacting') {
            this.send({ type: 'compact_status', active: true });
          } else if (status === null) {
            this.send({ type: 'compact_status', active: false });
          }
          return;
        }

        return;
      }

      case 'stream_event':
        this.handleStreamEvent(msg.event as unknown);
        return;

      case 'assistant':
        this.handleAssistant(msg);
        return;

      case 'user':
        this.handleUser(msg);
        return;

      case 'result':
        if (
          this.currentMessageId &&
          !this.finalizedMessageIds.has(this.currentMessageId)
        ) {
          this.finalizedMessageIds.add(this.currentMessageId);
          this.send({
            type: 'assistant_done',
            messageId: this.currentMessageId,
          });
        }
        this.send({
          type: 'result',
          subtype: msg.subtype,
          isError: msg.is_error,
          result: msg.subtype === 'success' ? msg.result : undefined,
          errors: 'errors' in msg ? (msg as { errors?: unknown }).errors : undefined,
          usage: (msg as Record<string, unknown>).usage,
          modelUsage: (msg as Record<string, unknown>).modelUsage,
        });
        return;

      default:
        // tool_progress and other internal SDK frames are dropped; the new
        // event vocabulary covers tool affordance via tool_use_start/done.
        return;
    }
  }

  done(): void {
    this.send({ type: 'done' });
  }

  error(message: string): void {
    this.send({ type: 'error', message });
  }

  emitSubscriptionAck(serverNonce: string, sessionId: string): void {
    this.send({ type: 'subscription_ack', serverNonce, sessionId });
  }

  emitPendingApproval(
    requestId: string,
    toolName: string,
    toolUseId: string,
    input: unknown,
    title?: string,
    description?: string,
    suggestions?: PermissionUpdate[],
  ): void {
    const inputSummary = this.summarizeInput(input);
    this.send({
      type: 'pending_approval',
      requestId,
      toolName,
      toolUseId,
      input,
      inputSummary,
      title,
      description,
      suggestions,
    });
  }

  emitPendingQuestion(requestId: string, questions: QuestionPayload[]): void {
    this.send({ type: 'pending_question', requestId, questions });
  }

  emitApprovalResolved(requestId: string): void {
    this.send({ type: 'approval_resolved', requestId });
  }

  emitAutoApproval(toolUseId: string, toolName: string, mode: 'auto' | 'readonly'): void {
    this.send({ type: 'auto_approval', toolUseId, toolName, mode });
  }

  emitInterrupted(messageId: string | null): void {
    this.send({ type: 'interrupted', messageId });
  }

  emitErrorNote(text: string): void {
    this.send({ type: 'error_note', text });
  }

  emitServerRestarted(serverNonce: string): void {
    this.send({ type: 'server_restarted', serverNonce });
  }

  emitHeartbeat(): void {
    if (this.res) {
      try {
        this.res.write('event: heartbeat\ndata: {}\n\n');
      } catch {
        // Ignore write errors on closed connections
      }
    }
  }

  /** Public wrapper so nested SubagentEmitter can emit events. */
  emitEvent(event: SseEvent): void {
    this.send(event);
  }

  startSubagent(parentToolUseId: string, description?: string): void {
    if (this.activeSubagents.has(parentToolUseId)) return;
    this.activeSubagents.set(
      parentToolUseId,
      new SubagentEmitter(parentToolUseId, this),
    );
    this.send({ type: 'subagent_start', parentToolUseId, description });
  }

  finalizeSubagent(parentToolUseId: string, state: 'completed' | 'error'): void {
    const emitter = this.activeSubagents.get(parentToolUseId);
    if (!emitter) return;
    emitter.done(state);
    this.activeSubagents.delete(parentToolUseId);
  }

  static formatSsePayload(id: string | number, event: SseEvent): string {
    return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private send(event: SseEvent): void {
    const id = this.eventIndex++;
    // Only log non-high-frequency events to avoid I/O backpressure
    if (event.type !== 'text_delta' && event.type !== 'thinking_delta' && event.type !== 'tool_input_delta' && event.type !== 'heartbeat') {
      diagLog(`[SseEmitter] send event ${id} type=${event.type} hasRes=${!!this.res}`);
    }
    const payload = SseEmitter.formatSsePayload(id, event);
    if (this.res) {
      const ok = this.res.write(payload);
      if (!ok) {
        diagWarn(`[SseEmitter] backpressure on event ${id} (${event.type})`);
      }
    } else {
      diagWarn(`[SseEmitter] event ${id} (${event.type}) dropped — no active response`);
    }
    this.onEvent?.(id, event);
  }

  private summarizeInput(input: unknown): string {
    if (input === null || input === undefined) return '';
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    if (str.length <= 200) return str;
    return str.slice(0, 200) + '…';
  }

  private handleStreamEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;
    const eventType = e.type;

    if (eventType === 'message_start') {
      const message = e.message as { id?: unknown } | undefined;
      const messageId = typeof message?.id === 'string' ? message.id : '';
      if (messageId) {
        this.currentMessageId = messageId;
        this.assistantStartEmitted = false;
        this.blockStates.clear();
        this.seenStreamPartIndexes.clear();
        this.nextPartIndex = 0;
        // Prevent unbounded growth of message-id history across long sessions
        if (this.finalizedMessageIds.size > 1000) {
          this.finalizedMessageIds.clear();
        }
      }
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof e.index === 'number' ? e.index : -1;
      const block = e.content_block as Record<string, unknown> | undefined;
      if (index < 0 || !block) return;

      this.ensureAssistantStart();

      const blockType = block.type;
      if (blockType === 'text') {
        this.blockStates.set(index, { type: 'text' });
        this.seenStreamPartIndexes.add(index);
      } else if (blockType === 'tool_use') {
        const toolUseId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : '';
        this.blockStates.set(index, {
          type: 'tool_use',
          toolUseId,
          toolName,
          inputBuffer: '',
        });
        this.seenStreamPartIndexes.add(index);
        if (this.currentMessageId) {
          this.send({
            type: 'tool_use_start',
            messageId: this.currentMessageId,
            partIndex: index,
            toolUseId,
            toolName,
          });
        }
        if (toolName === 'Agent' && toolUseId) {
          this.startSubagent(toolUseId);
        }
      } else if (blockType === 'thinking') {
        this.blockStates.set(index, { type: 'thinking' });
        this.seenStreamPartIndexes.add(index);
        if (this.currentMessageId) {
          this.send({
            type: 'thinking_start',
            messageId: this.currentMessageId,
            partIndex: index,
          });
        }
      } else {
        this.blockStates.set(index, { type: 'unknown' });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof e.index === 'number' ? e.index : -1;
      const delta = e.delta as Record<string, unknown> | undefined;
      if (index < 0 || !delta || !this.currentMessageId) return;

      const state = this.blockStates.get(index);
      if (!state) return;

      const deltaType = delta.type;
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        this.send({
          type: 'text_delta',
          messageId: this.currentMessageId,
          partIndex: index,
          text: delta.text,
        });
      } else if (
        deltaType === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        if (state.type === 'tool_use') {
          state.inputBuffer = (state.inputBuffer ?? '') + delta.partial_json;
          if (state.toolUseId) {
            this.send({
              type: 'tool_input_delta',
              messageId: this.currentMessageId,
              partIndex: index,
              toolUseId: state.toolUseId,
              partialJson: delta.partial_json,
            });
          }
        }
      } else if (
        deltaType === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        this.send({
          type: 'thinking_delta',
          messageId: this.currentMessageId,
          partIndex: index,
          text: delta.thinking,
        });
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof e.index === 'number' ? e.index : -1;
      if (index < 0) return;
      const state = this.blockStates.get(index);
      if (!state) return;

      if (state.type === 'tool_use' && state.toolUseId) {
        const input = this.parseToolInput(state.inputBuffer ?? '');
        this.send({
          type: 'tool_use_done',
          toolUseId: state.toolUseId,
          input,
        });
      } else if (state.type === 'thinking' && this.currentMessageId) {
        this.send({
          type: 'thinking_done',
          messageId: this.currentMessageId,
          partIndex: index,
        });
      }
      return;
    }

    if (eventType === 'message_stop') {
      if (
        this.currentMessageId &&
        !this.finalizedMessageIds.has(this.currentMessageId)
      ) {
        this.finalizedMessageIds.add(this.currentMessageId);
        this.send({
          type: 'assistant_done',
          messageId: this.currentMessageId,
        });
      }
      return;
    }

    // message_delta and other internal stream_event frames are ignored.
  }

  private handleAssistant(msg: SDKMessage & { type: 'assistant' }): void {
    const messageId =
      (msg.message as { id?: string }).id ?? '';
    const content = (msg.message as { content?: unknown }).content;

    if (messageId && messageId !== this.currentMessageId) {
      this.currentMessageId = messageId;
      this.assistantStartEmitted = false;
      this.nextPartIndex = 0;
    }
    this.ensureAssistantStart();

    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        if (this.seenStreamPartIndexes.has(index)) {
          this.closeStreamedBlock(block, index);
          return;
        }
        this.emitDedupRecovery(block, this.nextPartIndex++);
      });
    }

    // assistant_done is NOT fired here. The SDK splits an Anthropic API
    // message across multiple whole-turn `assistant` SDKMessage frames
    // (one per phase: thinking, then text, etc.), all sharing the same
    // `message.id`. Finalizing on each frame would mark the message done
    // before later phases arrive. Instead, assistant_done fires on
    // `message_stop` (stream_event) or, as a safety net, on the `result`
    // SDKMessage at end of turn.
  }

  private emitDedupRecovery(block: unknown, index: number): void {
    if (!block || typeof block !== 'object' || !this.currentMessageId) return;
    const b = block as Record<string, unknown>;
    const blockType = b.type;

    if (blockType === 'text') {
      const text = typeof b.text === 'string' ? b.text : '';
      if (text.length > 0) {
        this.send({
          type: 'text_delta',
          messageId: this.currentMessageId,
          partIndex: index,
          text,
        });
      }
    } else if (blockType === 'tool_use') {
      const toolUseId = typeof b.id === 'string' ? b.id : '';
      const toolName = typeof b.name === 'string' ? b.name : '';
      const input = b.input ?? {};
      this.send({
        type: 'tool_use_start',
        messageId: this.currentMessageId,
        partIndex: index,
        toolUseId,
        toolName,
      });
      this.send({ type: 'tool_use_done', toolUseId, input });
      if (toolName === 'Agent' && toolUseId) {
        this.startSubagent(toolUseId);
      }
    } else if (blockType === 'thinking') {
      const text = typeof b.thinking === 'string' ? b.thinking : '';
      this.send({
        type: 'thinking_start',
        messageId: this.currentMessageId,
        partIndex: index,
      });
      if (text.length > 0) {
        this.send({
          type: 'thinking_delta',
          messageId: this.currentMessageId,
          partIndex: index,
          text,
        });
      }
      this.send({
        type: 'thinking_done',
        messageId: this.currentMessageId,
        partIndex: index,
      });
    }
  }

  private closeStreamedBlock(block: unknown, index: number): void {
    if (!block || typeof block !== 'object' || !this.currentMessageId) return;
    const state = this.blockStates.get(index);
    if (!state) return;

    const b = block as Record<string, unknown>;
    const blockType = b.type;

    if (blockType === 'thinking' && state.type === 'thinking') {
      this.send({
        type: 'thinking_done',
        messageId: this.currentMessageId,
        partIndex: index,
      });
      this.blockStates.delete(index);
    } else if (
      blockType === 'tool_use' &&
      state.type === 'tool_use' &&
      state.toolUseId
    ) {
      const input = b.input ?? this.parseToolInput(state.inputBuffer ?? '');
      this.send({
        type: 'tool_use_done',
        toolUseId: state.toolUseId,
        input,
      });
      this.blockStates.delete(index);
    }
    // text blocks need no synthesized done event in our protocol.
  }

  private handleUser(msg: SDKMessage & { type: 'user' }): void {
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    const toolUseResult = (msg as Record<string, unknown>).toolUseResult;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') {
        const toolUseId =
          typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        const output = stringifyToolResult(b.content);
        const isError = b.is_error === true;
        this.send({
          type: 'tool_result',
          toolUseId,
          output,
          isError,
          ...(toolUseResult !== undefined && { toolUseResult }),
        });
        if (this.activeSubagents.has(toolUseId)) {
          this.finalizeSubagent(toolUseId, isError ? 'error' : 'completed');
        }
      }
    }
  }

  private ensureAssistantStart(): void {
    if (this.assistantStartEmitted || !this.currentMessageId) return;
    this.assistantStartEmitted = true;
    this.send({
      type: 'assistant_start',
      messageId: this.currentMessageId,
    });
  }

  private parseToolInput(buffer: string): unknown {
    if (buffer.length === 0) return {};
    try {
      return JSON.parse(buffer);
    } catch {
      return { _raw: buffer };
    }
  }
}

/**
 * Per-subagent SSE emitter nested inside SseEmitter.
 *
 * Processes SDK messages that carry a matching `parent_tool_use_id` and
 * emits `subagent_delta` / `subagent_done` events via the parent emitter.
 * State is scoped to a single subagent invocation.
 */
class SubagentEmitter {
  private parentToolUseId: string;
  private emitter: SseEmitter;
  private blockStates = new Map<number, BlockState>();

  constructor(parentToolUseId: string, emitter: SseEmitter) {
    this.parentToolUseId = parentToolUseId;
    this.emitter = emitter;
  }

  handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg.event as unknown);
        return;
      case 'assistant':
        this.handleAssistant(msg);
        return;
      case 'user':
        this.handleUser(msg);
        return;
      case 'result':
        this.done(msg.is_error ? 'error' : 'completed');
        return;
      default:
        return;
    }
  }

  done(state: 'completed' | 'error'): void {
    this.emitter.emitEvent({
      type: 'subagent_done',
      parentToolUseId: this.parentToolUseId,
      state,
    });
  }

  private handleStreamEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;
    const eventType = e.type;

    if (eventType === 'message_start') {
      this.blockStates.clear();
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof e.index === 'number' ? e.index : -1;
      const block = e.content_block as Record<string, unknown> | undefined;
      if (index < 0 || !block) return;

      const blockType = block.type;
      if (blockType === 'tool_use') {
        const toolUseId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : '';
        this.blockStates.set(index, {
          type: 'tool_use',
          toolUseId,
          toolName,
          inputBuffer: '',
        });
        this.emitDelta({
          kind: 'tool_use',
          toolUseId,
          toolName,
        });
      } else if (blockType === 'text') {
        this.blockStates.set(index, { type: 'text' });
      } else if (blockType === 'thinking') {
        this.blockStates.set(index, { type: 'thinking' });
      } else {
        this.blockStates.set(index, { type: 'unknown' });
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof e.index === 'number' ? e.index : -1;
      const delta = e.delta as Record<string, unknown> | undefined;
      if (index < 0 || !delta) return;

      const state = this.blockStates.get(index);
      if (!state) return;

      const deltaType = delta.type;
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        this.emitDelta({ kind: 'text', text: delta.text });
      } else if (
        deltaType === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        if (state.type === 'tool_use') {
          state.inputBuffer = (state.inputBuffer ?? '') + delta.partial_json;
        }
      } else if (
        deltaType === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        this.emitDelta({ kind: 'thinking', text: delta.thinking });
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof e.index === 'number' ? e.index : -1;
      if (index < 0) return;
      const state = this.blockStates.get(index);
      if (!state) return;

      if (state.type === 'tool_use' && state.toolUseId) {
        const input = this.parseToolInput(state.inputBuffer ?? '');
        this.emitDelta({
          kind: 'tool_use',
          toolUseId: state.toolUseId,
          toolName: state.toolName ?? '',
          input,
        });
      }
      this.blockStates.delete(index);
      return;
    }

    if (eventType === 'message_stop') {
      this.blockStates.clear();
      return;
    }
  }

  private handleAssistant(msg: SDKMessage & { type: 'assistant' }): void {
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const blockType = b.type;

      if (blockType === 'text') {
        const text = typeof b.text === 'string' ? b.text : '';
        if (text.length > 0) {
          this.emitDelta({ kind: 'text', text });
        }
      } else if (blockType === 'thinking') {
        const text = typeof b.thinking === 'string' ? b.thinking : '';
        if (text.length > 0) {
          this.emitDelta({ kind: 'thinking', text });
        }
      } else if (blockType === 'tool_use') {
        const toolUseId = typeof b.id === 'string' ? b.id : '';
        const toolName = typeof b.name === 'string' ? b.name : '';
        const input = b.input ?? {};
        this.emitDelta({
          kind: 'tool_use',
          toolUseId,
          toolName,
          input,
        });
      }
    }
  }

  private handleUser(msg: SDKMessage & { type: 'user' }): void {
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result') {
        const toolUseId =
          typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        const output = stringifyToolResult(b.content);
        const isError = b.is_error === true;
        this.emitDelta({
          kind: 'tool_result',
          toolUseId,
          output,
          isError,
        });
      }
    }
  }

  private emitDelta(
    delta: Extract<
      SseEvent,
      { type: 'subagent_delta' }
    >['delta'],
  ): void {
    this.emitter.emitEvent({
      type: 'subagent_delta',
      parentToolUseId: this.parentToolUseId,
      delta,
    });
  }

  private parseToolInput(buffer: string): unknown {
    if (buffer.length === 0) return {};
    try {
      return JSON.parse(buffer);
    } catch {
      return { _raw: buffer };
    }
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        pieces.push(b.text);
        continue;
      }
    }
    pieces.push('[Non-text tool output]');
  }
  return pieces.join('');
}
