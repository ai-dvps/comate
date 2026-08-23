import { ConverterError, converterError, converterLimits, type ConverterLimits } from './errors.js';

// Behavioral reference: CC Switch tree 5ca9459 streaming_codex_chat.rs and
// codex_responses_sse.rs; adapted to the pinned Codex fixture contract.
import { reasoningText, transformUsage } from './response-transform.js';
import { byteLength, canonicalJsonString, isRecord, type JsonRecord } from './shared.js';
import type { ToolNameSpec } from './request-transform.js';

export class SseFrameDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private text = '';
  private bufferedBytes = 0;
  private readonly maxFrameBytes: number;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? converterLimits().maxSseFrameBytes;
  }

  push(chunk: Uint8Array): string[] {
    this.bufferedBytes += chunk.byteLength;
    if (this.bufferedBytes > this.maxFrameBytes) {
      this.clear();
      throw converterError('sse_frame_too_large', 502);
    }
    try {
      this.text += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.clear();
      throw converterError('malformed_sse', 502);
    }
    const frames: string[] = [];
    let match = /\r?\n\r?\n/.exec(this.text);
    while (match?.index !== undefined) {
      frames.push(this.text.slice(0, match.index));
      const consumed = this.text.slice(0, match.index + match[0].length);
      this.text = this.text.slice(match.index + match[0].length);
      this.bufferedBytes -= Buffer.byteLength(consumed);
      match = /\r?\n\r?\n/.exec(this.text);
    }
    return frames;
  }

  finish(): string[] {
    try {
      this.text += this.decoder.decode();
    } catch {
      this.clear();
      throw converterError('malformed_sse', 502);
    }
    if (this.text.trim().length === 0) {
      this.clear();
      return [];
    }
    const trailing = this.text;
    this.clear();
    return [trailing];
  }

  status(): { bufferedBytes: number } {
    return { bufferedBytes: this.bufferedBytes };
  }

  clear(): void {
    this.text = '';
    this.bufferedBytes = 0;
  }
}

interface StreamOptions {
  responseId: string;
  model?: string;
  toolNames?: ReadonlyMap<string, ToolNameSpec>;
  limits?: Partial<ConverterLimits>;
}

export function responsesFailedEvent(input: {
  responseId: string;
  model?: string;
  error: ConverterError;
}): string {
  return event('response.failed', {
    type: 'response.failed',
    response: {
      id: input.responseId,
      object: 'response',
      created_at: 0,
      status: 'failed',
      error: {
        type: input.error.code,
        code: input.error.code,
        message: input.error.message,
      },
      incomplete_details: null,
      model: input.model ?? '',
      output: [],
      usage: null,
    },
  });
}

interface PendingTool {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
  itemId: string;
  started: boolean;
}

export class ChatSseToResponses {
  private readonly limits: ConverterLimits;
  private readonly decoder: SseFrameDecoder;
  private readonly output: JsonRecord[] = [];
  private readonly tools = new Map<number, PendingTool>();
  private created = false;
  private done = false;
  private cancelled = false;
  private failed = false;
  private cumulativeBytes = 0;
  private model: string;
  private usage: JsonRecord | null = null;
  private reasoning = '';
  private reasoningIndex: number | undefined;
  private text = '';
  private textIndex: number | undefined;
  private leadingContent = '';
  private finishReason: string | undefined;
  private finalResponse: JsonRecord | null = null;

  constructor(private readonly options: StreamOptions) {
    this.limits = converterLimits(options.limits);
    this.decoder = new SseFrameDecoder({ maxFrameBytes: this.limits.maxSseFrameBytes });
    this.model = options.model ?? '';
  }

  push(chunk: Uint8Array): string[] {
    if (this.cancelled || this.failed) return [];
    if (this.done) return [];
    try {
      return this.decoder.push(chunk).flatMap((frame) => this.convertFrame(frame));
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  finish(): string[] {
    if (this.cancelled || this.failed) return [];
    const events = this.decoder.finish().flatMap((frame) => this.convertFrame(frame));
    if (!this.done) {
      this.fail();
      throw converterError('upstream_stream_terminated', 502);
    }
    return events;
  }

  cancel(): void {
    this.cancelled = true;
    this.decoder.clear();
    this.discardPartial();
  }

  status(): { bufferedBytes: number; completed: boolean; cancelled: boolean } {
    return {
      bufferedBytes: this.decoder.status().bufferedBytes,
      completed: this.done,
      cancelled: this.cancelled,
    };
  }

  /** Returns continuity only after a complete stream; partial state is never publishable. */
  snapshot(): JsonRecord | null {
    if (!this.done || this.failed || this.cancelled || !this.finalResponse) return null;
    return structuredClone(this.finalResponse);
  }

  private convertFrame(frame: string): string[] {
    const dataLines = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return [];
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      if (!this.done) return this.complete(this.finishReason ?? 'stop');
      return [];
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw converterError('malformed_sse', 502);
    }
    if (!isRecord(chunk)) throw converterError('unsupported_event', 502);
    if (isRecord(chunk.error)) throw converterError('upstream_server', 502);
    if (typeof chunk.model === 'string') this.model = chunk.model;
    if (chunk.usage !== undefined) this.usage = transformUsage(chunk.usage);
    const events = this.ensureCreated();
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return events;
    const choice = chunk.choices[0];
    if (!isRecord(choice)) throw converterError('unsupported_event', 502);
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const reasoning = reasoningText(delta);
    if (reasoning) events.push(...this.appendReasoning(reasoning));
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push(...this.appendContent(delta.content));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const toolDelta of delta.tool_calls) events.push(...this.appendTool(toolDelta));
    }
    if (typeof choice.finish_reason === 'string') {
      this.finishReason = choice.finish_reason;
    }
    return events;
  }

  private ensureCreated(): string[] {
    if (this.created) return [];
    this.created = true;
    return [event('response.created', {
      type: 'response.created',
      response: this.response('in_progress', []),
    })];
  }

  private appendReasoning(delta: string, consume = true): string[] {
    if (consume) this.consume(delta);
    const events: string[] = [];
    if (this.reasoningIndex === undefined) {
      this.reasoningIndex = this.nextOutputIndex();
      events.push(event('response.output_item.added', {
        type: 'response.output_item.added', output_index: this.reasoningIndex,
        item: { id: this.reasoningItemId(), type: 'reasoning', status: 'in_progress', summary: [] },
      }));
      events.push(event('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', item_id: this.reasoningItemId(),
        output_index: this.reasoningIndex, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    this.reasoning += delta;
    events.push(event('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: this.reasoningItemId(),
      output_index: this.reasoningIndex, summary_index: 0, delta,
    }));
    return events;
  }

  private appendText(delta: string, consume = true): string[] {
    if (consume) this.consume(delta);
    const events: string[] = [];
    if (this.textIndex === undefined) {
      this.textIndex = this.nextOutputIndex();
      events.push(event('response.output_item.added', {
        type: 'response.output_item.added', output_index: this.textIndex,
        item: { id: this.messageItemId(), type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }));
      events.push(event('response.content_part.added', {
        type: 'response.content_part.added', item_id: this.messageItemId(),
        output_index: this.textIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    }
    this.text += delta;
    events.push(event('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: this.messageItemId(),
      output_index: this.textIndex, content_index: 0, delta,
    }));
    return events;
  }

  private appendContent(delta: string): string[] {
    if (this.textIndex !== undefined) return this.appendText(delta);
    // Count undecided leading content as it arrives. A fragmented, unclosed
    // `<think>` prefix must not grow outside the cumulative response budget.
    this.consume(delta);
    this.leadingContent += delta;
    const trimmed = this.leadingContent.trimStart();
    if ('<think>'.startsWith(trimmed)) return [];
    if (trimmed.startsWith('<think>')) {
      const close = trimmed.indexOf('</think>');
      if (close < 0) return [];
      const reasoning = trimmed.slice('<think>'.length, close).trim();
      const answer = trimmed.slice(close + '</think>'.length).trimStart();
      this.leadingContent = '';
      return [
        ...(reasoning ? this.appendReasoning(reasoning, false) : []),
        ...(answer ? this.appendText(answer, false) : []),
      ];
    }
    const content = this.leadingContent;
    this.leadingContent = '';
    return this.appendText(content, false);
  }

  private appendTool(raw: unknown): string[] {
    if (!isRecord(raw) || typeof raw.index !== 'number') throw converterError('unsupported_event', 502);
    const index = raw.index;
    let pending = this.tools.get(index);
    if (!pending) {
      pending = {
        id: typeof raw.id === 'string' ? raw.id : `call_${index}`,
        name: '', arguments: '', outputIndex: this.nextOutputIndex(),
        itemId: `fc_${this.options.responseId}_${index}`, started: false,
      };
      this.tools.set(index, pending);
    }
    if (typeof raw.id === 'string') pending.id = raw.id;
    const fn = isRecord(raw.function) ? raw.function : {};
    if (typeof fn.name === 'string') {
      this.consume(fn.name);
      pending.name += fn.name;
    }
    const events: string[] = [];
    if (!pending.started && pending.name) {
      pending.started = true;
      const spec = this.options.toolNames?.get(pending.name);
      events.push(event('response.output_item.added', {
        type: 'response.output_item.added', output_index: pending.outputIndex,
        item: {
          id: pending.itemId, type: spec?.kind === 'custom' ? 'custom_tool_call' : 'function_call',
          status: 'in_progress', call_id: pending.id, name: spec?.name ?? pending.name,
          ...(spec?.namespace ? { namespace: spec.namespace } : {}),
          ...(spec?.kind === 'custom' ? { input: '' } : { arguments: '' }),
        },
      }));
    }
    if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
      this.consume(fn.arguments);
      pending.arguments += fn.arguments;
      if (byteLength(pending.arguments) > this.limits.maxToolArgumentBytes) {
        throw converterError('tool_arguments_too_large', 502);
      }
      const spec = this.options.toolNames?.get(pending.name);
      // A custom tool is represented upstream as a function with a JSON
      // `{input:string}` argument. Raw JSON fragments are not valid Codex
      // custom-input deltas, so publish one decoded delta only after the
      // complete bounded argument value has been validated.
      if (spec?.kind !== 'custom') {
        events.push(event('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: pending.itemId,
          output_index: pending.outputIndex, delta: fn.arguments,
        }));
      }
    }
    return events;
  }

  private complete(finishReason = 'stop'): string[] {
    if (this.done) return [];
    const events: string[] = [];
    if (this.leadingContent) {
      const trimmed = this.leadingContent.trimStart();
      if (trimmed.startsWith('<think>') && !trimmed.includes('</think>')) {
        throw converterError('unsupported_event', 502);
      }
      events.push(...this.appendText(this.leadingContent, false));
      this.leadingContent = '';
    }
    if (this.reasoningIndex !== undefined) {
      const item = this.reasoningItem();
      events.push(event('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done', item_id: this.reasoningItemId(),
        output_index: this.reasoningIndex, summary_index: 0, text: this.reasoning,
      }));
      events.push(event('response.output_item.done', {
        type: 'response.output_item.done', output_index: this.reasoningIndex, item,
      }));
      this.output[this.reasoningIndex] = item;
    }
    if (this.textIndex !== undefined) {
      const item = this.messageItem();
      events.push(event('response.output_text.done', {
        type: 'response.output_text.done', item_id: this.messageItemId(),
        output_index: this.textIndex, content_index: 0, text: this.text,
      }));
      events.push(event('response.output_item.done', {
        type: 'response.output_item.done', output_index: this.textIndex, item,
      }));
      this.output[this.textIndex] = item;
    }
    for (const pending of [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (!pending.started) throw converterError('unsupported_event', 502);
      const spec = this.options.toolNames?.get(pending.name);
      const args = canonicalJsonString(pending.arguments);
      const item = {
        id: pending.itemId, type: spec?.kind === 'custom' ? 'custom_tool_call' : 'function_call',
        status: 'completed', call_id: pending.id, name: spec?.name ?? pending.name,
        ...(spec?.namespace ? { namespace: spec.namespace } : {}),
        ...(spec?.kind === 'custom'
          ? { input: customInput(args) }
          : { arguments: args }),
      };
      const doneType = spec?.kind === 'custom'
        ? 'response.custom_tool_call_input.done'
        : 'response.function_call_arguments.done';
      if (spec?.kind === 'custom') {
        const input = customInput(args);
        if (input) {
          events.push(event('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta', item_id: pending.itemId,
            output_index: pending.outputIndex, delta: input,
          }));
        }
      }
      events.push(event(doneType, {
        type: doneType, item_id: pending.itemId,
        output_index: pending.outputIndex,
        ...(spec?.kind === 'custom' ? { input: customInput(args) } : { arguments: args }),
      }));
      events.push(event('response.output_item.done', {
        type: 'response.output_item.done', output_index: pending.outputIndex, item,
      }));
      this.output[pending.outputIndex] = item;
    }
    this.done = true;
    const incomplete = finishReason === 'length' || finishReason === 'content_filter';
    const response = this.response(incomplete ? 'incomplete' : 'completed');
    if (incomplete) response.incomplete_details = {
      reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter',
    };
    this.finalResponse = structuredClone(response);
    events.push(event(incomplete ? 'response.incomplete' : 'response.completed', {
      type: incomplete ? 'response.incomplete' : 'response.completed', response,
    }));
    return events;
  }

  private response(status: string, output = this.output.filter(Boolean)): JsonRecord {
    return {
      id: this.options.responseId, object: 'response', created_at: 0, status,
      error: null, incomplete_details: null, model: this.model, output,
      usage: this.usage,
    };
  }

  private nextOutputIndex(): number {
    const indexes = [this.reasoningIndex, this.textIndex, ...[...this.tools.values()].map((tool) => tool.outputIndex)]
      .filter((value): value is number => value !== undefined);
    return indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
  }

  private consume(value: string): void {
    this.cumulativeBytes += byteLength(value);
    if (this.cumulativeBytes > this.limits.maxResponseBytes) {
      throw converterError('response_too_large', 502);
    }
  }

  private reasoningItemId(): string { return `rs_${this.options.responseId}`; }
  private messageItemId(): string { return `msg_${this.options.responseId}`; }
  private reasoningItem(): JsonRecord {
    return { id: this.reasoningItemId(), type: 'reasoning', summary: [{ type: 'summary_text', text: this.reasoning }] };
  }
  private messageItem(): JsonRecord {
    return {
      id: this.messageItemId(), type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: this.text, annotations: [] }],
    };
  }

  private fail(): void {
    this.failed = true;
    this.decoder.clear();
    this.discardPartial();
  }

  private discardPartial(): void {
    this.output.length = 0;
    this.tools.clear();
    this.reasoning = '';
    this.text = '';
    this.leadingContent = '';
    this.cumulativeBytes = 0;
  }
}

function event(type: string, payload: JsonRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function customInput(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as { input?: unknown };
    return typeof parsed.input === 'string' ? parsed.input : argumentsJson;
  } catch {
    return argumentsJson;
  }
}
