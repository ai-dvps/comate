/**
 * opencode-transcript — translates opencode REST message history
 * ({info, parts}) into the claude-shaped SessionMessage model used by the
 * subagent panel and history rendering (U7). The inverse direction (live
 * events) is opencode-event-mapper; this module covers stored transcripts.
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapToolName } from './opencode-event-mapper.js';

export interface OpencodeRestPart {
  id: string;
  type: string;
  messageID: string;
  text?: string;
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

export interface OpencodeRestMessage {
  info: {
    id: string;
    role: string;
    time?: { created?: number; completed?: number };
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
      if (part.type === 'text') {
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
        uuid: msg.info.id,
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
