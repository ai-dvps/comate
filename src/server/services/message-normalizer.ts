import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagePart, MessageRole, TaskItem } from '../types/message.js';

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
  tool_use_meta?: unknown;
  _meta?: unknown;
  meta?: unknown;
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

function extractToolMeta(
  rawMeta: unknown,
): { displayName?: string; iconUrl?: string } | undefined {
  if (!rawMeta || typeof rawMeta !== 'object') return undefined;
  const meta = rawMeta as Record<string, unknown>;
  const displayName = typeof meta.display_name === 'string' ? meta.display_name : undefined;
  const iconUrl = typeof meta.icon_url === 'string' ? meta.icon_url : undefined;
  if (!displayName && !iconUrl) return undefined;
  return { displayName, iconUrl };
}

/**
 * Convert an Anthropic-SDK `content` array (or string, for legacy user
 * messages) into the app's `MessagePart[]` shape.
 *
 * Unknown block types are skipped with a single `console.warn` per type per
 * process lifetime.
 */
export function partsFromSdkContent(
  content: unknown,
  toolUseResult?: unknown,
  toolUseMeta?: unknown,
): MessagePart[] {
  const metaArray = Array.isArray(toolUseMeta) ? toolUseMeta : undefined;
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
        const topLevelMeta = metaArray?.[parts.length];
        const meta = extractToolMeta(topLevelMeta ?? b.tool_use_meta ?? b._meta ?? b.meta);
        parts.push({
          type: 'tool_use',
          toolUseId: asString(b.id),
          toolName: asString(b.name),
          input: b.input ?? {},
          state: 'complete',
          ...(meta && { meta }),
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
          ...(toolUseResult !== undefined && { toolUseResult }),
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

  // Synthetic `<task-notification>` user messages are model context the CLI
  // injects when a background task settles, not real user content. Drop them
  // so the XML never renders as a chat bubble; task state reaches the Tasks
  // panel through the structured task_* system messages on a separate path.
  // See plan 2026-07-21-001-fix-hide-task-notification-xml-plan.md.
  if (role === 'user' && isTaskNotificationSessionMessage(sessionMessage)) {
    return null;
  }

  const raw = sessionMessage.message as RawMessage | null | undefined;
  const toolUseResult = (sessionMessage as Record<string, unknown>).toolUseResult;
  const rawMessage = sessionMessage.message as Record<string, unknown> | undefined;
  const toolUseMeta = rawMessage?.tool_use_meta;
  const parts = raw ? partsFromSdkContent(raw.content, toolUseResult, toolUseMeta) : [];

  const subtype = typeof rawMessage?.subtype === 'string' ? rawMessage.subtype : '';
  const isCompactBoundary = subtype === 'compact_boundary';

  if (parts.length === 0 && !isCompactBoundary) {
    return null;
  }

  return {
    id: sessionMessage.uuid,
    role,
    parts: parts.length > 0 ? parts : [{ type: 'text', text: 'Conversation compacted' }],
    timestamp: Date.now(),
    isCompactBoundary,
  };
}

function roleFromType(type: SessionMessage['type']): MessageRole | null {
  if (type === 'user') return 'user';
  if (type === 'assistant') return 'assistant';
  if (type === 'system') return 'system';
  return null;
}

/**
 * Reduce a user message's content to a single string when it is purely text.
 * Returns '' for any non-text content (a tool_result-bearing user message, an
 * image block, a non-text part) so a wrapper-shape test cannot match mixed
 * content.
 */
function reduceUserMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      return '';
    }
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    } else {
      return '';
    }
  }
  return texts.join('');
}

const TASK_NOTIFICATION_OPEN = '<task-notification';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

/**
 * True when the body is wholly a `<task-notification>…</task-notification>`
 * wrapper — not a tag embedded in larger prose. Surrounding whitespace trims.
 */
function isTaskNotificationWrapper(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return trimmed.startsWith(TASK_NOTIFICATION_OPEN) && trimmed.endsWith(TASK_NOTIFICATION_CLOSE);
}

/**
 * Identify the synthetic user-role `<task-notification>` message the CLI
 * injects when a background task settles. The primary signal on the historical
 * path is the wrapper text — the persisted `SessionMessage` shape does not
 * expose `origin` (it is a live-envelope `SDKUserMessage` field). The
 * `origin.kind === 'task-notification'` provenance is a secondary confirmation
 * when that field survives into the persisted record.
 */
function isTaskNotificationSessionMessage(sessionMessage: SessionMessage): boolean {
  const origin = (sessionMessage as Record<string, unknown>).origin;
  if (origin && typeof origin === 'object') {
    const kind = (origin as { kind?: unknown }).kind;
    if (kind === 'task-notification') {
      return true;
    }
  }
  const raw = sessionMessage.message as { content?: unknown } | null | undefined;
  return isTaskNotificationWrapper(reduceUserMessageText(raw?.content));
}

function normalizeSdkStatus(status: string): TaskItem['status'] {
  switch (status) {
    case 'pending': return 'pending';
    case 'running': return 'in_progress';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'killed': return 'killed';
    case 'paused': return 'paused';
    default: return 'pending';
  }
}

/**
 * Scan raw SDK session messages for task lifecycle system messages and
 * rebuild the session's task list. This mirrors the client-side
 * scanMessagesForTasks but operates on raw SDK shapes before normalization.
 */
export function scanSdkMessagesForTasks(sdkMessages: SessionMessage[]): TaskItem[] {
  const taskMap = new Map<string, TaskItem>();

  for (const msg of sdkMessages) {
    if (msg.type !== 'system') continue;
    const m = msg.message as Record<string, unknown> | undefined;
    if (!m) continue;
    const subtype = typeof m.subtype === 'string' ? m.subtype : '';

    if (subtype === 'task_started') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const description = typeof m.description === 'string' ? m.description : '';
      if (taskId) {
        taskMap.set(taskId, {
          id: taskId,
          subject: description,
          status: 'pending',
        });
      }
    } else if (subtype === 'task_updated') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const patch = m.patch as Record<string, unknown> | undefined;
      if (taskId && taskMap.has(taskId) && patch) {
        const task = taskMap.get(taskId)!;
        if (typeof patch.status === 'string') {
          task.status = normalizeSdkStatus(patch.status);
        }
        if (typeof patch.description === 'string') {
          task.subject = patch.description;
        }
      }
    } else if (subtype === 'task_progress') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const description = typeof m.description === 'string' ? m.description : '';
      if (taskId && taskMap.has(taskId) && description) {
        taskMap.get(taskId)!.subject = description;
      }
    } else if (subtype === 'task_notification') {
      const taskId = typeof m.task_id === 'string' ? m.task_id : '';
      const status = typeof m.status === 'string' ? m.status : '';
      if (taskId && taskMap.has(taskId) && status) {
        taskMap.get(taskId)!.status = normalizeSdkStatus(status);
      }
    }
  }

  return Array.from(taskMap.values());
}
