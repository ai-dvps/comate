import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagePart, MessageRole } from '../types/message.js';

/**
 * Track unknown SDK block types we've already warned about, to avoid log
 * floods when a session contains many of the same unrecognized type.
 */
const warnedUnknownBlockTypes = new Set<string>();

interface RawMessage {
  role?: unknown;
  content?: unknown;
}

interface RawTextBlock {
  type: 'text';
  text?: unknown;
}

interface RawToolUseBlock {
  type: 'tool_use';
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface RawToolResultBlock {
  type: 'tool_result';
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface RawThinkingBlock {
  type: 'thinking';
  thinking?: unknown;
}

type RawBlock =
  | RawTextBlock
  | RawToolUseBlock
  | RawToolResultBlock
  | RawThinkingBlock
  | { type: string };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Flatten an Anthropic `tool_result.content` payload to a single string.
 * The SDK persists tool results as either a bare string or an array of content
 * blocks. Non-text blocks (images, etc.) collapse to a placeholder marker —
 * tool outputs render as plain monospace; see Assumptions in plan
 * 2026-05-16-006 for the rationale.
 */
function stringifyOutput(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
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

/**
 * Convert an Anthropic-SDK `content` array (or string, for legacy user
 * messages) into the app's `MessagePart[]` shape.
 *
 * Unknown block types are skipped with a single `console.warn` per type per
 * process lifetime.
 */
export function partsFromSdkContent(content: unknown): MessagePart[] {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: MessagePart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as RawBlock;
    switch (block.type) {
      case 'text': {
        const text = asString((block as RawTextBlock).text);
        if (text.length > 0) {
          parts.push({ type: 'text', text });
        }
        break;
      }
      case 'tool_use': {
        const b = block as RawToolUseBlock;
        parts.push({
          type: 'tool_use',
          toolUseId: asString(b.id),
          toolName: asString(b.name),
          input: b.input ?? {},
          state: 'complete',
        });
        break;
      }
      case 'tool_result': {
        const b = block as RawToolResultBlock;
        parts.push({
          type: 'tool_result',
          toolUseId: asString(b.tool_use_id),
          output: stringifyOutput(b.content),
          isError: b.is_error === true,
        });
        break;
      }
      case 'thinking': {
        const text = asString((block as RawThinkingBlock).thinking);
        parts.push({ type: 'thinking', text, state: 'complete' });
        break;
      }
      default: {
        const unknownType = String(block.type);
        if (!warnedUnknownBlockTypes.has(unknownType)) {
          warnedUnknownBlockTypes.add(unknownType);
          console.warn(
            `[message-normalizer] Skipping unknown SDK block type: ${unknownType}`,
          );
        }
        break;
      }
    }
  }
  return parts;
}

/**
 * Normalize a single SDK `SessionMessage` (whose `.message` is `unknown`) to
 * the app's `ChatMessage` shape. Role derives from the SDK's outer `type`
 * field; system messages are dropped from the visible transcript by returning
 * `null` here only when the message has no displayable parts — caller filters
 * nulls before returning to the client.
 */
export function normalizeSessionMessage(
  sessionMessage: SessionMessage,
): ChatMessage | null {
  const role = roleFromType(sessionMessage.type);
  if (!role) return null;

  const raw = sessionMessage.message as RawMessage | null | undefined;
  const parts = raw ? partsFromSdkContent(raw.content) : [];
  if (parts.length === 0) {
    return null;
  }

  return {
    id: sessionMessage.uuid,
    role,
    parts,
    timestamp: Date.now(),
  };
}

function roleFromType(type: SessionMessage['type']): MessageRole | null {
  if (type === 'user') return 'user';
  if (type === 'assistant') return 'assistant';
  // SDK system messages are subprocess control frames (init, etc.) — not
  // transcript content. Drop from the visible message list.
  return null;
}
