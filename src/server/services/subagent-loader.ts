import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  SubagentMessage,
  SubagentPart,
  SubagentState,
} from '../types/message.js';

interface RawBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Flatten a tool_result content payload to a single string. Mirrors the main
 * transcript normalizer but operates on raw subagent blocks.
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

function partsFromSdkContent(content: unknown): SubagentPart[] {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: SubagentPart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as RawBlock;
    switch (block.type) {
      case 'text': {
        const text = asString(block.text);
        if (text.length > 0) {
          parts.push({ type: 'text', text });
        }
        break;
      }
      case 'thinking': {
        const text = asString(block.thinking);
        if (text.length > 0) {
          parts.push({ type: 'thinking', text });
        }
        break;
      }
      case 'tool_use': {
        parts.push({
          type: 'tool_use',
          toolUseId: asString(block.id),
          toolName: asString(block.name),
          input: block.input ?? {},
        });
        break;
      }
      case 'tool_result': {
        parts.push({
          type: 'tool_result',
          toolUseId: asString(block.tool_use_id),
          output: stringifyOutput(block.content),
          isError: block.is_error === true,
        });
        break;
      }
      default:
        // Skip unknown block types silently
        break;
    }
  }
  return parts;
}

function parseTimestamp(msg: SessionMessage): number | null {
  const raw = msg as unknown as { timestamp?: string };
  if (!raw.timestamp) return null;
  const parsed = Date.parse(raw.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function isResultMessage(msg: SessionMessage): boolean {
  return (msg as unknown as { type?: string }).type === 'result';
}

function deriveState(
  sdkMessages: SessionMessage[],
  messages: SubagentMessage[],
): SubagentState['state'] {
  // A dedicated result entry is the canonical completion marker.
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (isResultMessage(msg)) {
      const raw = msg.message as { is_error?: unknown } | undefined;
      return raw?.is_error === true ? 'error' : 'completed';
    }
  }

  const last = messages[messages.length - 1];
  if (!last) {
    return 'running';
  }

  if (last.role === 'assistant') {
    return 'completed';
  }

  // If the transcript ends on a user tool_result that reports an error,
  // treat the subagent as failed even when no result entry is present.
  if (last.role === 'user' && last.parts.some((p) => p.type === 'tool_result' && p.isError)) {
    return 'error';
  }

  return 'running';
}

function deriveProgressHint(
  messages: SubagentMessage[],
  description?: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (part.type === 'text') {
        return part.text.slice(0, 80);
      }
      if (part.type === 'tool_use') {
        const inputStr = JSON.stringify(part.input);
        if (inputStr.length > 60) {
          return `${part.toolName}: ${inputStr.slice(0, 60)}…`;
        }
        return `${part.toolName}: ${inputStr}`;
      }
    }
  }
  return description ?? '';
}

interface ReconstructOptions {
  fallbackStartTime?: number;
  fallbackEndTime?: number;
}

/**
 * Convert raw subagent SDK messages into the client-side SubagentState shape.
 * Returns null when no displayable messages could be reconstructed.
 */
export function reconstructSubagentState(
  parentToolUseId: string,
  sdkMessages: SessionMessage[],
  description?: string,
  options: ReconstructOptions = {},
): SubagentState | null {
  const messages: SubagentMessage[] = [];
  let toolCount = 0;

  for (const msg of sdkMessages) {
    const type = (msg as unknown as { type?: string }).type;
    if (type !== 'assistant' && type !== 'user') {
      continue;
    }

    const raw = msg.message as { content?: unknown } | undefined;
    const parts = raw ? partsFromSdkContent(raw.content) : [];
    if (parts.length === 0) {
      continue;
    }

    messages.push({
      id: msg.uuid,
      role: type === 'assistant' ? 'assistant' : 'user',
      parts,
    });

    toolCount += parts.filter((p) => p.type === 'tool_use').length;
  }

  if (messages.length === 0) {
    return null;
  }

  const firstTs = parseTimestamp(sdkMessages[0]);
  const lastTs = parseTimestamp(sdkMessages[sdkMessages.length - 1]);
  const startTime = firstTs ?? options.fallbackStartTime ?? Date.now();
  const state = deriveState(sdkMessages, messages);
  const endTime =
    state !== 'running'
      ? (lastTs ?? options.fallbackEndTime ?? Date.now())
      : undefined;
  const progressHint = deriveProgressHint(messages, description);

  return {
    parentToolUseId,
    description: description ?? parentToolUseId,
    state,
    startTime,
    endTime,
    toolCount,
    progressHint,
    messages,
  };
}
