import type { Response } from 'express';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SseEvent } from '../types/message.js';

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
 *
 * Thinking-emission behavior: if the SDK does NOT surface a thinking block
 * via `stream_event`, the whole-turn `assistant` event recovers it through
 * `emitDedupRecovery`, which fires the `*_start` / `*_delta` / `*_done`
 * triple in one synchronous burst (no shimmer phase, acceptable
 * degradation per plan 2026-05-16-006 U4).
 */
export class SseEmitter {
  private res: Response;
  private currentMessageId: string | null = null;
  private assistantStartEmitted = false;
  private blockStates = new Map<number, BlockState>();
  private seenStreamPartIndexes = new Set<number>();

  constructor(res: Response) {
    this.res = res;
  }

  handle(msg: SDKMessage): void {
    // Drop subagent activity for v1; only main-turn messages render.
    if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
      return;
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.send({
            type: 'system_init',
            model: msg.model,
            tools: msg.tools,
            sessionId: msg.session_id,
          });
        }
        return;

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
        this.send({
          type: 'result',
          subtype: msg.subtype,
          isError: msg.is_error,
          result: msg.subtype === 'success' ? msg.result : undefined,
          errors: 'errors' in msg ? (msg as { errors?: unknown }).errors : undefined,
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

  private send(event: SseEvent): void {
    this.res.write(`event: ${event.type}\n`);
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
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

    // message_delta / message_stop / etc → ignored; assistant_done is
    // finalized on the whole-turn `assistant` SDKMessage.
  }

  private handleAssistant(msg: SDKMessage & { type: 'assistant' }): void {
    const messageId =
      (msg.message as { id?: string }).id ?? '';
    const content = (msg.message as { content?: unknown }).content;

    if (messageId && messageId !== this.currentMessageId) {
      this.currentMessageId = messageId;
      this.assistantStartEmitted = false;
    }
    this.ensureAssistantStart();

    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        if (this.seenStreamPartIndexes.has(index)) return;
        this.emitDedupRecovery(block, index);
      });
    }

    if (this.currentMessageId) {
      this.send({
        type: 'assistant_done',
        messageId: this.currentMessageId,
      });
    }
    this.resetTurn();
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
        this.send({ type: 'tool_result', toolUseId, output, isError });
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

  private resetTurn(): void {
    this.blockStates.clear();
    this.seenStreamPartIndexes.clear();
    this.assistantStartEmitted = false;
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
