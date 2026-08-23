import { createHash, createHmac } from 'node:crypto';

// Behavioral reference: CC Switch tree 5ca9459, especially
// transform_codex_chat.rs and codex_chat_common.rs. This is a bounded
// TypeScript adaptation for Comate's declared Codex contract, not a proxy port.

import { converterError, converterLimits, type ConverterLimits } from './errors.js';
import { prepareRequestHistory } from './history.js';
import { byteLength, canonicalJsonString, isRecord, type JsonRecord } from './shared.js';

export interface PromptCacheIdentityInput {
  providerId: string;
  credential: string;
  sessionId: string;
  /** Route generations must not rotate a Provider/session cache identity. */
  routeId?: string;
}

export interface RequestTransformOptions extends PromptCacheIdentityInput {
  promptCacheRouting?: 'auto' | 'unsupported';
  effortWireMapping?: Partial<Record<string, string>>;
  suppressSamplingParameters?: boolean;
  limits?: Partial<ConverterLimits>;
}

export interface ToolNameSpec {
  name: string;
  namespace?: string;
  kind: 'function' | 'custom';
}

export interface TransformedChatRequest {
  body: JsonRecord;
  toolNames: Map<string, ToolNameSpec>;
}

export function derivePromptCacheIdentity(input: PromptCacheIdentityInput): string {
  const providerKey = createHash('sha256')
    .update('comate-codex-chat-cache-v1\0')
    .update(input.providerId)
    .update('\0')
    .update(input.credential)
    .digest();
  const digest = createHmac('sha256', providerKey)
    .update('session\0')
    .update(input.sessionId)
    .digest('base64url');
  return `pc_${digest}`;
}

export function transformResponsesRequest(
  request: unknown,
  options: RequestTransformOptions,
): TransformedChatRequest {
  const limits = converterLimits(options.limits);
  if (byteLength(request) > limits.maxRequestBytes) throw converterError('request_too_large', 413);
  if (!isRecord(request)) throw converterError('invalid_request', 400);
  const history = prepareRequestHistory(request, limits);
  const messages: JsonRecord[] = [];
  const instructions = instructionText(request.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof request.input === 'string') messages.push({ role: 'user', content: request.input });

  const toolNames = new Map<string, ToolNameSpec>();
  const tools = convertTools(request.tools, toolNames);
  const media = { images: 0, bytes: 0 };
  let pendingReasoning = '';
  for (const item of history) {
    if (item.type === 'reasoning') {
      pendingReasoning = reasoningHistoryText(item);
      continue;
    }
    appendInputItem(item, messages, toolNames, media, limits, pendingReasoning);
    if (pendingReasoning && itemConsumesReasoning(item)) pendingReasoning = '';
  }

  const body: JsonRecord = { messages };
  copyString(request, body, 'model');
  if (request.max_output_tokens !== undefined) body.max_completion_tokens = request.max_output_tokens;
  else if (request.max_completion_tokens !== undefined) body.max_completion_tokens = request.max_completion_tokens;
  else if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (!options.suppressSamplingParameters) {
    copy(request, body, 'temperature');
    copy(request, body, 'top_p');
  }
  copy(request, body, 'stream');
  copy(request, body, 'parallel_tool_calls');
  if (request.stream === true) body.stream_options = { include_usage: true };
  if (tools.length > 0) {
    body.tools = tools;
    if (request.tool_choice !== undefined) body.tool_choice = convertToolChoice(request.tool_choice, toolNames);
  }

  const requestedEffort = isRecord(request.reasoning) && typeof request.reasoning.effort === 'string'
    ? request.reasoning.effort
    : undefined;
  if (requestedEffort) {
    const mapped = options.effortWireMapping?.[requestedEffort];
    if (options.effortWireMapping && !mapped) throw converterError('invalid_request', 400);
    body.reasoning_effort = mapped ?? requestedEffort;
  }
  if (options.promptCacheRouting === 'auto') {
    body.prompt_cache_key = derivePromptCacheIdentity(options);
  }
  return { body, toolNames };
}

function instructionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean).join('\n');
}

function appendInputItem(
  item: JsonRecord,
  messages: JsonRecord[],
  toolNames: Map<string, ToolNameSpec>,
  media: { images: number; bytes: number },
  limits: ConverterLimits,
  reasoning: string,
): void {
  if (typeof item.role === 'string') {
    const role = item.role === 'developer' ? 'system' : item.role;
    if (!['system', 'user', 'assistant'].includes(role)) throw converterError('invalid_request', 400);
    messages.push({
      role,
      content: convertContent(item.content, media, limits),
      ...(role === 'assistant' && reasoning ? { reasoning_content: reasoning } : {}),
    });
    return;
  }
  switch (item.type) {
    case 'function_call':
    case 'custom_tool_call': {
      const callId = requiredString(item.call_id ?? item.id);
      const originalName = requiredString(item.name);
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      const chatName = flattenedToolName(originalName, namespace);
      const args = item.type === 'custom_tool_call'
        ? JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' })
        : canonicalJsonString(requiredString(item.arguments));
      if (byteLength(args) > limits.maxToolArgumentBytes) {
        throw converterError('tool_arguments_too_large', 413);
      }
      toolNames.set(chatName, { name: originalName, namespace, kind: item.type === 'custom_tool_call' ? 'custom' : 'function' });
      const previous = messages.at(-1);
      const toolCall = { id: callId, type: 'function', function: { name: chatName, arguments: args } };
      if (previous?.role === 'assistant' && previous.content === null && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        });
      }
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      messages.push({
        role: 'tool',
        tool_call_id: requiredString(item.call_id),
        content: outputText(item.output),
      });
      return;
    default:
      throw converterError('invalid_request', 400);
  }
}

function convertContent(
  value: unknown,
  media: { images: number; bytes: number },
  limits: ConverterLimits,
): string | JsonRecord[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw converterError('invalid_request', 400);
  const parts: JsonRecord[] = [];
  for (const part of value) {
    if (!isRecord(part)) throw converterError('invalid_request', 400);
    if (part.type === 'input_text' || part.type === 'output_text') {
      parts.push({ type: 'text', text: requiredString(part.text) });
    } else if (part.type === 'input_image') {
      const url = requiredString(part.image_url);
      if (!url.startsWith('https://') && !url.startsWith('data:image/')) {
        throw converterError('unsupported_media', 400);
      }
      media.images += 1;
      media.bytes += byteLength(url);
      if (media.images > limits.maxImages) throw converterError('image_limit_exceeded', 413);
      if (media.bytes > limits.maxImageBytes) throw converterError('image_bytes_exceeded', 413);
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof part.detail === 'string' ? { detail: part.detail } : {}),
        },
      });
    } else {
      throw converterError('unsupported_media', 400);
    }
  }
  return parts;
}

function convertTools(value: unknown, names: Map<string, ToolNameSpec>): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw converterError('invalid_request', 400);
  const converted: JsonRecord[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) throw converterError('invalid_request', 400);
    if (tool.type === 'namespace') {
      const namespace = requiredString(tool.name);
      if (!Array.isArray(tool.tools)) throw converterError('invalid_request', 400);
      for (const child of tool.tools) converted.push(convertFunctionTool(child, names, namespace));
    } else if (tool.type === 'function') {
      converted.push(convertFunctionTool(tool, names));
    } else if (tool.type === 'custom') {
      const name = requiredString(tool.name);
      names.set(name, { name, kind: 'custom' });
      converted.push({
        type: 'function',
        function: {
          name,
          description: typeof tool.description === 'string' ? tool.description : 'Custom string-input tool',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      });
    } else {
      // Hosted Responses tools (for example `web_search`) have no honest Chat
      // equivalent. U6 must disable them for routed sessions; never drop them.
      throw converterError('unsupported_event', 400);
    }
  }
  return converted;
}

function convertFunctionTool(value: unknown, names: Map<string, ToolNameSpec>, namespace?: string): JsonRecord {
  if (!isRecord(value) || value.type !== 'function') throw converterError('invalid_request', 400);
  const name = requiredString(value.name);
  const chatName = flattenedToolName(name, namespace);
  names.set(chatName, { name, namespace, kind: 'function' });
  return {
    type: 'function',
    function: {
      name: chatName,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      parameters: normalizedParameters(value.parameters),
      ...(typeof value.strict === 'boolean' ? { strict: value.strict } : {}),
    },
  };
}

function normalizedParameters(value: unknown): JsonRecord {
  const parameters = isRecord(value) ? structuredClone(value) : {};
  if (typeof parameters.type !== 'string') parameters.type = 'object';
  if (parameters.type === 'object' && !isRecord(parameters.properties)) parameters.properties = {};
  return parameters;
}

function reasoningHistoryText(item: JsonRecord): string {
  if (Array.isArray(item.summary)) {
    return item.summary
      .map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n\n');
  }
  return typeof item.content === 'string' ? item.content : '';
}

function itemConsumesReasoning(item: JsonRecord): boolean {
  return item.type === 'function_call'
    || item.type === 'custom_tool_call'
    || item.role === 'assistant';
}

function convertToolChoice(value: unknown, names: Map<string, ToolNameSpec>): unknown {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) throw converterError('invalid_request', 400);
  const name = requiredString(value.name);
  const namespace = typeof value.namespace === 'string' ? value.namespace : undefined;
  const chatName = flattenedToolName(name, namespace);
  if (!names.has(chatName)) throw converterError('invalid_request', 400);
  return { type: 'function', function: { name: chatName } };
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && Array.isArray(value.content)) {
    const parts = value.content.map((part: unknown) => {
      if (!isRecord(part) || part.type !== 'input_text' || typeof part.text !== 'string') {
        throw converterError('unsupported_media', 400);
      }
      return part.text;
    });
    return parts.join('\n');
  }
  return JSON.stringify(value ?? '');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw converterError('invalid_request', 400);
  return value;
}

function copy(source: JsonRecord, target: JsonRecord, key: string): void {
  if (source[key] !== undefined) target[key] = source[key];
}

function copyString(source: JsonRecord, target: JsonRecord, key: string): void {
  if (typeof source[key] === 'string') target[key] = source[key];
}

function flattenedToolName(name: string, namespace?: string): string {
  const full = namespace ? `${namespace}__${name}` : name;
  if (full.length <= 64) return full;
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 12);
  return `${full.slice(0, 50)}__${digest}`;
}
