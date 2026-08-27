/**
 * opencode-event-mapper — translates opencode SSE events into the internal
 * SDKMessage-shaped message model (KTD-1: the client and renderers never
 * branch on backend). Pure and per-session-stateful; the adapter owns one
 * state per opencode session.
 *
 * Mapping notes:
 * - text/reasoning stream as content_block_start + *_delta via part.delta
 *   events, with suffix-synthesis from part.updated as fallback.
 * - Tool calls translate opencode's complete input at 'running' into the
 *   Anthropic-shaped input_json_delta stream consumed by SseEmitter, and a
 *   user tool_result on completed/error.
 * - todo.updated maps to the task panel's task_started/task_updated system
 *   messages; opencode lowercase tool names map to their claude display names
 *   (todowrite → TodoWrite, etc.) so renderers and the task panel key off the
 *   same vocabulary.
 * - permission.asked / question.asked are NOT mapped here — the adapter
 *   routes them into the session core's unified approval/question flow.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface OpencodeEventEnvelope {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpencodeMapperState {
  partIndexById: Map<string, number>;
  nextIndex: number;
  startedMessages: Set<string>;
  startedParts: Set<string>;
  openTextLikeParts: Set<string>;
  completedTools: Set<string>;
  partTypeById: Map<string, string>;
  lastTextByPartId: Map<string, string>;
  seenTodos: Set<string>;
  /**
   * Maps opencode message IDs to their declared role (from `message.updated`).
   * Parts are only rendered when the owning message is an assistant message,
   * so a user message's text part is not echoed back as an assistant reply.
   */
  messageRoleById: Map<string, string>;
  currentMessageId?: string;
  currentModel?: string;
  /**
   * Set when a session.error arrives; idles are suppressed (no false
   * success) until new activity marks a fresh turn. Prevents an error turn
   * from ending in a fake-success state that masks the failure (silent-error
   * fix — provider errors like 1211 model-not-found ended invisibly before).
   */
  erroredTurn: boolean;
  /** Context overflow is recoverable while OpenCode auto-compacts. Keep it
   * pending until compaction succeeds or the session becomes idle. */
  pendingContextOverflow?: { message: string; sessionID: string };
  lastUsage?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export function createOpencodeMapperState(): OpencodeMapperState {
  return {
    partIndexById: new Map(),
    nextIndex: 0,
    startedMessages: new Set(),
    startedParts: new Set(),
    openTextLikeParts: new Set(),
    completedTools: new Set(),
    partTypeById: new Map(),
    lastTextByPartId: new Map(),
    seenTodos: new Set(),
    messageRoleById: new Map(),
    erroredTurn: false,
  };
}

const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'List',
  task: 'Task',
  webfetch: 'WebFetch',
  todowrite: 'TodoWrite',
  question: 'AskUserQuestion',
  skill: 'Skill',
};

export function mapToolName(opencodeTool: string): string {
  return (
    TOOL_NAME_MAP[opencodeTool] ??
    opencodeTool.charAt(0).toUpperCase() + opencodeTool.slice(1)
  );
}

const TODO_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'completed',
};

interface OpencodePart {
  id: string;
  type: string;
  messageID: string;
  sessionID?: string;
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

interface OpencodeMessageInfo {
  id: string;
  role: string;
  modelID?: string;
  tokens?: OpencodeMapperState['lastUsage'];
}

function ensureMessageStart(state: OpencodeMapperState, messageID: string): SDKMessage[] {
  if (state.startedMessages.has(messageID)) return [];
  state.startedMessages.add(messageID);
  state.currentMessageId = messageID;
  return [
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: messageID,
          role: 'assistant',
          model: state.currentModel ?? 'opencode',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    } as unknown as SDKMessage,
  ];
}

function blockIndex(state: OpencodeMapperState, partId: string): number {
  const existing = state.partIndexById.get(partId);
  if (existing !== undefined) return existing;
  const index = state.nextIndex;
  state.nextIndex += 1;
  state.partIndexById.set(partId, index);
  return index;
}

/** Returns true when a part on this message should be rendered as assistant content.
 * Unknown roles are treated as assistant for backwards compatibility with events
 * that arrive before (or without) a `message.updated`. */
function shouldRenderAssistantPart(state: OpencodeMapperState, messageID: string): boolean {
  const role = state.messageRoleById.get(messageID);
  return role === undefined || role === 'assistant';
}

function mapTextLikePart(
  part: OpencodePart,
  state: OpencodeMapperState,
  kind: 'text' | 'thinking',
): SDKMessage[] {
  const out: SDKMessage[] = [];
  const index = blockIndex(state, part.id);
  if (!state.startedParts.has(part.id)) {
    state.startedParts.add(part.id);
    state.openTextLikeParts.add(part.id);
    out.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      },
    } as unknown as SDKMessage);
  }
  const full = part.text ?? '';
  const seen = state.lastTextByPartId.get(part.id) ?? '';
  if (full.length > seen.length && full.startsWith(seen)) {
    const suffix = full.slice(seen.length);
    state.lastTextByPartId.set(part.id, full);
    if (suffix) {
      out.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index,
          delta: kind === 'text' ? { type: 'text_delta', text: suffix } : { type: 'thinking_delta', thinking: suffix },
        },
      } as unknown as SDKMessage);
    }
  }
  return out;
}

function closeOpenTextLikeParts(state: OpencodeMapperState): SDKMessage[] {
  const out: SDKMessage[] = [];
  for (const partId of state.openTextLikeParts) {
    const index = state.partIndexById.get(partId);
    if (index === undefined) continue;
    out.push({
      type: 'stream_event',
      event: { type: 'content_block_stop', index },
    } as unknown as SDKMessage);
  }
  state.openTextLikeParts.clear();
  return out;
}

function mapToolPart(part: OpencodePart, state: OpencodeMapperState): SDKMessage[] {
  const out: SDKMessage[] = [];
  const callId = part.callID ?? part.id;
  const status = part.state?.status;
  const toolName = mapToolName(part.tool ?? 'unknown');

  if (!state.startedParts.has(part.id) && status === 'running') {
    state.startedParts.add(part.id);
    const index = blockIndex(state, part.id);
    const input = part.state?.input ?? {};
    out.push(...ensureMessageStart(state, part.messageID));
    out.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: callId, name: toolName, input: {} },
      },
    } as unknown as SDKMessage);
    out.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    } as unknown as SDKMessage);
    out.push({
      type: 'stream_event',
      event: { type: 'content_block_stop', index },
    } as unknown as SDKMessage);
  }

  if ((status === 'completed' || status === 'error') && !state.completedTools.has(callId)) {
    state.completedTools.add(callId);
    out.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: status === 'error' ? (part.state?.error ?? '') : (part.state?.output ?? ''),
            is_error: status === 'error',
          },
        ],
      },
    } as unknown as SDKMessage);
  }
  return out;
}

function mapTodoUpdated(
  properties: Record<string, unknown>,
  state: OpencodeMapperState,
): SDKMessage[] {
  const todos = (properties.todos ?? properties) as Array<{
    id?: string;
    content: string;
    status: string;
  }>;
  if (!Array.isArray(todos)) return [];
  const out: SDKMessage[] = [];
  for (const [i, todo] of todos.entries()) {
    const taskId = todo.id ?? `todo-${i}-${todo.content.slice(0, 24)}`;
    const status = TODO_STATUS_MAP[todo.status] ?? todo.status;
    if (!state.seenTodos.has(taskId)) {
      state.seenTodos.add(taskId);
      out.push({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        description: todo.content,
      } as unknown as SDKMessage);
    }
    out.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch: { status, description: todo.content },
    } as unknown as SDKMessage);
  }
  return out;
}

function usageToSdk(
  usage: OpencodeMapperState['lastUsage'],
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_read_input_tokens: usage.cache?.read ?? 0,
    cache_creation_input_tokens: usage.cache?.write ?? 0,
    output_tokens_details: { thinking_tokens: usage.reasoning ?? 0 },
  };
}

function errorResult(message: string, sessionID: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
    session_id: sessionID,
    errors: [message],
  } as unknown as SDKMessage;
}

export function mapOpencodeEvent(
  event: OpencodeEventEnvelope,
  state: OpencodeMapperState,
): SDKMessage[] {
  const properties = event.properties ?? {};

  // Errored-turn reset only on activity that genuinely starts a NEW turn:
  // a part on a not-yet-started message, or a user-role message update. The
  // failed turn's own in-flight message flushing its final state must NOT
  // re-enable a success result (that would re-mask the error).
  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const partMessageId = String(
      (properties.part as { messageID?: string } | undefined)?.messageID ??
      properties.messageID ??
      '',
    );
    if (partMessageId && !state.startedMessages.has(partMessageId)) {
      state.erroredTurn = false;
    }
  } else if (event.type === 'message.updated') {
    const info = (properties.info ?? properties) as { role?: string };
    if (info.role === 'user') {
      state.erroredTurn = false;
    }
  }

  switch (event.type) {
    case 'message.updated': {
      const info = (properties.info ?? properties) as OpencodeMessageInfo;
      state.messageRoleById.set(info.id, info.role);
      if (info.tokens) state.lastUsage = info.tokens;
      if (info.modelID) state.currentModel = info.modelID;
      if (info.role !== 'assistant') return [];
      return ensureMessageStart(state, info.id);
    }

    case 'message.part.updated': {
      const part = properties.part as OpencodePart | undefined;
      if (!part) return [];
      if (!shouldRenderAssistantPart(state, part.messageID)) return [];
      state.partTypeById.set(part.id, part.type);
      if (part.type === 'text') {
        return [
          ...ensureMessageStart(state, part.messageID),
          ...mapTextLikePart(part, state, 'text'),
        ];
      }
      if (part.type === 'reasoning') {
        return [
          ...ensureMessageStart(state, part.messageID),
          ...mapTextLikePart(part, state, 'thinking'),
        ];
      }
      if (part.type === 'tool') {
        return mapToolPart(part, state);
      }
      return [];
    }

    case 'message.part.delta': {
      const partId = String(properties.partID ?? properties.partId ?? '');
      const field = String(properties.field ?? 'text');
      const delta = String(properties.delta ?? '');
      if (!partId || field !== 'text' || !delta) return [];
      const messageID = String(properties.messageID ?? state.currentMessageId ?? '');
      if (!messageID || !shouldRenderAssistantPart(state, messageID)) return [];
      const partType = state.partTypeById.get(partId) ?? 'text';
      const kind = partType === 'reasoning' ? 'thinking' : 'text';
      const index = blockIndex(state, partId);
      const out: SDKMessage[] = [];
      if (messageID) out.push(...ensureMessageStart(state, messageID));
      if (!state.startedParts.has(partId)) {
        state.startedParts.add(partId);
        state.openTextLikeParts.add(partId);
        out.push({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index,
            content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
          },
        } as unknown as SDKMessage);
      }
      state.lastTextByPartId.set(partId, (state.lastTextByPartId.get(partId) ?? '') + delta);
      out.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index,
          delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta },
        },
      } as unknown as SDKMessage);
      return out;
    }

    case 'todo.updated':
      return mapTodoUpdated(properties, state);

    case 'session.idle': {
      if (state.pendingContextOverflow) {
        const pending = state.pendingContextOverflow;
        state.pendingContextOverflow = undefined;
        state.erroredTurn = true;
        return [
          ...closeOpenTextLikeParts(state),
          { type: 'system', subtype: 'status', status: null } as unknown as SDKMessage,
          errorResult(pending.message, pending.sessionID),
        ];
      }
      if (state.erroredTurn) return [];
      const usage = usageToSdk(state.lastUsage);
      state.lastUsage = undefined;
      return [
        ...closeOpenTextLikeParts(state),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
          session_id: String(properties.sessionID ?? ''),
          usage,
          modelUsage: {},
        } as unknown as SDKMessage,
      ];
    }

    case 'session.compacted': {
      const recoveredContextOverflow = state.pendingContextOverflow !== undefined;
      state.pendingContextOverflow = undefined;
      if (recoveredContextOverflow) state.erroredTurn = false;
      return [
        { type: 'system', subtype: 'status', status: null } as unknown as SDKMessage,
        { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage,
      ];
    }

    case 'session.error': {
      const error = (properties.error ?? {}) as { name?: string; data?: { message?: string }; message?: string };
      const message = error.data?.message ?? error.message ?? 'unknown error';
      const sessionID = String(properties.sessionID ?? '');
      if (error.name === 'ContextOverflowError') {
        const alreadyCompacting = state.pendingContextOverflow !== undefined;
        state.pendingContextOverflow = { message, sessionID };
        if (alreadyCompacting) return [];
        return [
          ...closeOpenTextLikeParts(state),
          { type: 'system', subtype: 'status', status: 'compacting' } as unknown as SDKMessage,
        ];
      }
      const wasCompacting = state.pendingContextOverflow !== undefined;
      state.pendingContextOverflow = undefined;
      state.erroredTurn = true;
      return [
        ...closeOpenTextLikeParts(state),
        ...(wasCompacting
          ? [{ type: 'system', subtype: 'status', status: null } as unknown as SDKMessage]
          : []),
        errorResult(message, sessionID),
      ];
    }

    default:
      return [];
  }
}
