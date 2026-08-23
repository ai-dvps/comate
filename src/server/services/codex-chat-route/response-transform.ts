import { converterError, converterLimits, safeUpstreamError, type ConverterLimits } from './errors.js';

// Behavioral reference: CC Switch tree 5ca9459 transform_codex_chat.rs.
import { byteLength, canonicalJsonString, isRecord, splitThink, type JsonRecord } from './shared.js';
import type { ToolNameSpec } from './request-transform.js';

export interface ResponseTransformOptions {
  toolNames?: ReadonlyMap<string, ToolNameSpec>;
  responseId?: string;
  limits?: Partial<ConverterLimits>;
}

export function transformChatResponse(
  input: unknown,
  options: ResponseTransformOptions = {},
): JsonRecord {
  const limits = converterLimits(options.limits);
  if (byteLength(input) > limits.maxResponseBytes) throw converterError('response_too_large', 502);
  if (!isRecord(input)) throw converterError('invalid_request', 502);
  if (isRecord(input.error)) {
    const code = typeof input.error.code === 'string' ? input.error.code : '';
    throw safeUpstreamError({ status: code.includes('auth') || code.includes('api_key') ? 401 : 500 });
  }
  if (!Array.isArray(input.choices) || !isRecord(input.choices[0])) {
    throw converterError('unsupported_event', 502);
  }
  const choice = input.choices[0];
  const message = isRecord(choice.message) ? choice.message : {};
  const output: JsonRecord[] = [];
  const content = typeof message.content === 'string' ? message.content : '';
  const explicitReasoning = reasoningText(message);
  const split = explicitReasoning ? { reasoning: explicitReasoning, text: content } : splitThink(content);
  if (split.reasoning) {
    output.push({
      id: `rs_${safeId(input.id)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: split.reasoning }],
    });
  }
  if (split.text) {
    output.push({
      id: `msg_${safeId(input.id)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: split.text, annotations: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      if (!isRecord(rawCall) || !isRecord(rawCall.function)) throw converterError('unsupported_event', 502);
      const callId = requiredString(rawCall.id);
      const chatName = requiredString(rawCall.function.name);
      const spec = options.toolNames?.get(chatName);
      const args = canonicalJsonString(requiredString(rawCall.function.arguments));
      if (byteLength(args) > limits.maxToolArgumentBytes) {
        throw converterError('tool_arguments_too_large', 502);
      }
      if (spec?.kind === 'custom') {
        let customInput = args;
        try {
          const parsed = JSON.parse(args) as { input?: unknown };
          if (typeof parsed.input === 'string') customInput = parsed.input;
        } catch {
          // Preserve the exact upstream input when it is not JSON.
        }
        output.push({
          id: `ctc_${safeId(callId)}`,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: callId,
          name: spec.name,
          input: customInput,
        });
      } else {
        output.push({
          id: `fc_${safeId(callId)}`,
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: spec?.name ?? chatName,
          ...(spec?.namespace ? { namespace: spec.namespace } : {}),
          arguments: args,
        });
      }
    }
  }

  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const incomplete = finishReason === 'length' || finishReason === 'content_filter';
  return {
    id: options.responseId ?? (typeof input.id === 'string' ? `resp_${input.id}` : 'resp_chat'),
    object: 'response',
    created_at: typeof input.created === 'number' ? input.created : 0,
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete
      ? { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' }
      : null,
    model: typeof input.model === 'string' ? input.model : '',
    output,
    usage: transformUsage(input.usage),
  };
}

export function transformUsage(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberValue(value.prompt_tokens);
  const outputTokens = numberValue(value.completion_tokens);
  const inputDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const outputDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: numberValue(inputDetails.cached_tokens) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: numberValue(outputDetails.reasoning_tokens) },
    total_tokens: typeof value.total_tokens === 'number'
      ? value.total_tokens
      : inputTokens + outputTokens,
  };
}

export function reasoningText(value: JsonRecord): string | undefined {
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof value[key] === 'string' && value[key].length > 0) return value[key];
  }
  if (isRecord(value.reasoning)) {
    for (const key of ['content', 'text', 'summary']) {
      if (typeof value.reasoning[key] === 'string' && value.reasoning[key].length > 0) {
        return value.reasoning[key];
      }
    }
  }
  if (Array.isArray(value.reasoning_details)) {
    const parts = value.reasoning_details
      .map((part) => isRecord(part) ? part.text ?? part.content ?? part.summary : undefined)
      .filter((part): part is string => typeof part === 'string');
    if (parts.length > 0) return parts.join('\n\n');
  }
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw converterError('unsupported_event', 502);
  return value;
}

function safeId(value: unknown): string {
  return typeof value === 'string' && value.length > 0
    ? value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)
    : 'chat';
}
