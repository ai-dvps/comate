import { byteLength } from './shared.js';
import { converterError, converterLimits, type ConverterLimits } from './errors.js';

// Behavioral reference: CC Switch tree 5ca9459 codex_chat_history.rs. Unlike
// that general proxy, the pinned Codex fixture is transcript-complete, so this
// route validates continuity without retaining cross-request state.

type JsonRecord = Record<string, unknown>;

/**
 * Codex 0.149 sends `store: false` requests with the transcript items needed
 * for tool continuity. This validator deliberately does not own a cross-request
 * cache: complete input survives route regeneration and process restart, while
 * a response-id-only continuation fails closed.
 */
export function prepareRequestHistory(
  request: unknown,
  limitOverrides?: Partial<ConverterLimits>,
): JsonRecord[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw converterError('invalid_request', 400);
  }
  const record = request as JsonRecord;
  if (typeof record.previous_response_id === 'string' && record.previous_response_id.length > 0) {
    // Chat Completions has no equivalent. The pinned app-server characterization
    // is transcript-complete and omits this field; accepting an opaque cursor
    // would silently drop text or tool history after regeneration/restart.
    throw converterError('continuity_state_required', 409);
  }
  const input = record.input;
  const items = Array.isArray(input)
    ? input
    : input === undefined || typeof input === 'string'
      ? []
      : [input];
  const limits = converterLimits(limitOverrides);
  if (items.length > limits.maxHistoryItems || byteLength(items) > limits.maxHistoryBytes) {
    throw converterError('history_too_large', 413);
  }

  const availableCalls = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const callId = stringValue(item.call_id) ?? stringValue(item.id);
      if (callId) availableCalls.add(callId);
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const callId = stringValue(item.call_id);
      if (callId && !availableCalls.has(callId)) {
        // `previous_response_id` is opaque to a stateless route. Guessing or
        // sharing a process cache here would break restart/session isolation.
        throw converterError('continuity_state_required', 409);
      }
    }
  }
  return items.filter(isRecord);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
