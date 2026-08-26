/**
 * opencode-transcript — translates opencode REST message history
 * ({info, parts}) into the claude-shaped SessionMessage model used by the
 * subagent panel and history rendering (U7). The inverse direction (live
 * events) is opencode-event-mapper; this module covers stored transcripts.
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageMediaType, MessagePart } from '../types/message.js';
import { isImageMediaType } from '../utils/image-input-profile.js';
import { mapToolName } from './opencode-event-mapper.js';

export interface OpencodeRestPart {
  id: string;
  type: string;
  messageID: string;
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
  /** Some transcript exporters retain the part shell after media compaction. */
  compacted?: boolean;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    title?: string;
  };
}

function safeDisplayName(value: string | undefined): string | undefined {
  const leaf = value?.split(/[\\/]/).pop()?.split('')
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join('').trim();
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, 255) : undefined;
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function unavailableImagePart(
  mediaType: ImageMediaType,
  name: string | undefined,
  reason: string,
): MessagePart {
  return {
    type: 'image',
    mediaType,
    ...(name && { name }),
    source: { type: 'unavailable', reason },
  };
}

function imagePartFromOpencode(part: OpencodeRestPart): MessagePart | undefined {
  if (part.type !== 'file' || !isImageMediaType(part.mime)) return undefined;
  const mediaType = part.mime;
  const name = safeDisplayName(part.filename);
  if (part.compacted) {
    return unavailableImagePart(mediaType, name, 'Image content was removed during backend compaction.');
  }
  if (!part.url) {
    return unavailableImagePart(mediaType, name, 'Backend transcript no longer contains image data.');
  }

  if (part.url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.url);
    if (!match || match[1].toLowerCase() !== mediaType || !isCanonicalBase64(match[2])) {
      return unavailableImagePart(mediaType, name, 'Backend transcript contains invalid image data.');
    }
    return {
      type: 'image',
      mediaType,
      ...(name && { name }),
      source: { type: 'base64', data: match[2] },
    };
  }

  // Never mount backend-supplied remote URLs in history: doing so would turn
  // transcript viewing into an unsolicited network request to that origin.
  return unavailableImagePart(mediaType, name, 'Backend transcript image URL is unavailable.');
}

const COMATE_MESSAGE_ID_RE =
  /^msg_comate_([0-9a-f]{8})([0-9a-f]{4})([1-8][0-9a-f]{3})([89ab][0-9a-f]{3})([0-9a-f]{12})$/i;

function decodeComateMessageId(messageId: string): string {
  const match = COMATE_MESSAGE_ID_RE.exec(messageId);
  if (!match) return messageId;
  return match.slice(1).join('-').toLowerCase();
}

export interface OpencodeRestMessage {
  info: {
    id: string;
    role: string;
    time?: { created?: number; completed?: number };
    modelID?: string;
    providerID?: string;
    cost?: number;
    tokens?: {
      total?: number;
      input: number;
      output: number;
      reasoning?: number;
      cache: { read: number; write: number };
    };
    /** Present on failed assistant turns: the provider/agent error that ended
     * the turn (e.g. APIError 1211 model-not-found). opencode stores it on the
     * message, so a failed turn can be made visible in history. */
    error?: { name?: string; data?: { message?: string }; message?: string };
  };
  parts: OpencodeRestPart[];
}

/** Visible history marker for a failed turn. The live path surfaces the same
 * failure as an error_note event; system-typed transcript messages are
 * dropped by the normalizer, so history needs an assistant text message. */
function formatBackendError(error: OpencodeRestMessage['info']['error']): string {
  const name = error?.name ?? 'Error';
  const message = error?.data?.message ?? error?.message ?? 'unknown error';
  return `**后端错误** (${name})\n\n${message}`;
}

export function opencodeMessagesToSessionMessages(
  messages: OpencodeRestMessage[],
): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const msg of messages) {
    const content: unknown[] = [];
    const toolResults: unknown[] = [];
    for (const part of msg.parts) {
      const imagePart = imagePartFromOpencode(part);
      if (imagePart) {
        content.push(imagePart);
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.text ?? '' });
      } else if (part.type === 'reasoning') {
        content.push({ type: 'thinking', thinking: part.text ?? '' });
      } else if (part.type === 'tool') {
        const callId = part.callID ?? part.id;
        content.push({
          type: 'tool_use',
          id: callId,
          name: mapToolName(part.tool ?? 'unknown'),
          input: part.state?.input ?? {},
        });
        if (part.state?.status === 'completed' || part.state?.status === 'error') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: callId,
            content: part.state.status === 'error'
              ? (part.state.error ?? '')
              : (part.state.output ?? ''),
            is_error: part.state.status === 'error',
          });
        }
      }
    }

    if (content.length > 0 || msg.info.role === 'user') {
      out.push({
        uuid: msg.info.role === 'user' ? decodeComateMessageId(msg.info.id) : msg.info.id,
        type: msg.info.role === 'user' ? 'user' : 'assistant',
        parent_tool_use_id: null,
        session_id: '',
        message: { role: msg.info.role === 'user' ? 'user' : 'assistant', content },
      } as unknown as SessionMessage);
    }
    if (toolResults.length > 0) {
      out.push({
        uuid: `${msg.info.id}-results`,
        type: 'user',
        parent_tool_use_id: null,
        session_id: '',
        message: { role: 'user', content: toolResults },
      } as unknown as SessionMessage);
    }

    if (msg.info.error) {
      out.push({
        uuid: `${msg.info.id}-error`,
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: '',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: formatBackendError(msg.info.error) }],
        },
      } as unknown as SessionMessage);
    }
  }
  return out;
}

/** Pair parent task tool_use callIDs to child sessions, ordered by creation. */
export function pairTaskToolCallsWithChildren(
  parentMessages: OpencodeRestMessage[],
  childCount: number,
): Array<{ parentToolUseId: string; description?: string }> {
  if (!Array.isArray(parentMessages)) return [];
  const taskParts: Array<{ callID: string; description?: string }> = [];
  for (const msg of parentMessages) {
    for (const part of msg.parts) {
      if (part.type === 'tool' && part.tool === 'task') {
        const input = (part.state?.input ?? {}) as { description?: string; prompt?: string };
        taskParts.push({
          callID: part.callID ?? part.id,
          description: input.description ?? input.prompt?.slice(0, 80),
        });
      }
    }
  }
  return taskParts.slice(0, childCount).map((part) => ({
    parentToolUseId: part.callID,
    description: part.description,
  }));
}
