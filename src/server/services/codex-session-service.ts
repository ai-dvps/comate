import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import type { ThreadItem } from '../generated/codex-protocol/v2/ThreadItem.js';
import type { ThreadReadResponse } from '../generated/codex-protocol/v2/ThreadReadResponse.js';
import type { Thread } from '../generated/codex-protocol/v2/Thread.js';
import type { ThreadListResponse } from '../generated/codex-protocol/v2/ThreadListResponse.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';
import { projectCodexToolItem } from './codex-event-mapper.js';
import type { ContextUsageSnapshot, TurnTokenUsage } from '../types/message.js';

interface RolloutTokenCounts {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

function rolloutCounts(value: unknown): RolloutTokenCounts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string): number =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? Math.max(0, raw[key] as number) : 0;
  return {
    totalTokens: number('total_tokens'),
    inputTokens: number('input_tokens'),
    cachedInputTokens: number('cached_input_tokens'),
    cacheWriteInputTokens: number('cache_write_input_tokens'),
    outputTokens: number('output_tokens'),
    reasoningOutputTokens: number('reasoning_output_tokens'),
  };
}

function addCounts(left: RolloutTokenCounts | undefined, right: RolloutTokenCounts): RolloutTokenCounts {
  return {
    totalTokens: (left?.totalTokens ?? 0) + right.totalTokens,
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    cachedInputTokens: (left?.cachedInputTokens ?? 0) + right.cachedInputTokens,
    cacheWriteInputTokens: (left?.cacheWriteInputTokens ?? 0) + right.cacheWriteInputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    reasoningOutputTokens: (left?.reasoningOutputTokens ?? 0) + right.reasoningOutputTokens,
  };
}

function subtractCounts(next: RolloutTokenCounts, previous: RolloutTokenCounts): RolloutTokenCounts | undefined {
  const keys = Object.keys(next) as Array<keyof RolloutTokenCounts>;
  if (keys.some((key) => next[key] < previous[key])) return undefined;
  return Object.fromEntries(keys.map((key) => [key, next[key] - previous[key]])) as unknown as RolloutTokenCounts;
}

function toSettlement(value: RolloutTokenCounts): TurnTokenUsage {
  return {
    quality: 'estimated',
    totalTokens: value.totalTokens,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cachedInputTokens,
    cacheWriteTokens: value.cacheWriteInputTokens,
    thinkingTokens: value.reasoningOutputTokens,
  };
}

interface CodexRolloutHistory {
  settlements: Map<string, TurnTokenUsage>;
  contextUsage?: ContextUsageSnapshot;
}

function parseCodexRolloutHistory(contents: string): CodexRolloutHistory {
  const settlements = new Map<string, TurnTokenUsage>();
  let contextUsage: ContextUsageSnapshot | undefined;
  let lastTotal: RolloutTokenCounts | undefined;
  let active: { turnId: string; usage?: RolloutTokenCounts } | undefined;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const event = payload as Record<string, unknown>;
    if (event.type === 'task_started' && typeof event.turn_id === 'string') {
      active = { turnId: event.turn_id };
      continue;
    }
    if (event.type === 'token_count') {
      const info = event.info;
      if (!active || !info || typeof info !== 'object' || Array.isArray(info)) continue;
      const details = info as Record<string, unknown>;
      const total = rolloutCounts(details.total_token_usage);
      const last = rolloutCounts(details.last_token_usage);
      const maxTokens = typeof details.model_context_window === 'number'
        ? details.model_context_window
        : 0;
      if (last && maxTokens > 0) {
        contextUsage = {
          totalTokens: last.totalTokens,
          maxTokens,
          rawMaxTokens: maxTokens,
          percentage: (last.totalTokens / maxTokens) * 100,
          categories: [
            { name: 'input', tokens: last.inputTokens },
            { name: 'cached input', tokens: last.cachedInputTokens },
            { name: 'output', tokens: last.outputTokens },
            { name: 'reasoning', tokens: last.reasoningOutputTokens },
          ],
        };
      }
      if (!total) continue;
      if (!lastTotal) {
        if (last) active.usage = addCounts(active.usage, last);
      } else if (total.totalTokens !== lastTotal.totalTokens) {
        const delta = subtractCounts(total, lastTotal);
        active.usage = delta ? addCounts(active.usage, delta) : last;
      }
      lastTotal = total;
      continue;
    }
    if (event.type === 'task_complete' && typeof event.turn_id === 'string'
        && active?.turnId === event.turn_id) {
      if (active.usage) settlements.set(active.turnId, toSettlement(active.usage));
      active = undefined;
    }
  }
  return { settlements, contextUsage };
}

export function parseCodexRolloutTokenUsage(contents: string): Map<string, TurnTokenUsage> {
  return parseCodexRolloutHistory(contents).settlements;
}

async function readRolloutHistory(path: string | null): Promise<CodexRolloutHistory> {
  if (!path) return { settlements: new Map() };
  try {
    return parseCodexRolloutHistory(await readFile(path, 'utf8'));
  } catch {
    return { settlements: new Map() };
  }
}

export class CodexSessionService {
  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  async loadMessages(threadId: string): Promise<SessionMessage[]> {
    return (await this.loadMessagesWithContext(threadId)).messages;
  }

  async loadMessagesWithContext(
    threadId: string,
  ): Promise<{ messages: SessionMessage[]; contextUsage?: ContextUsageSnapshot }> {
    const response = await this.manager.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true });
    const history = await readRolloutHistory(response.thread.path);
    const messages = response.thread.turns.flatMap((turn) => {
      const messages = turn.items.flatMap((item) => mapItem(threadId, item));
      const settlement = history.settlements.get(turn.id);
      if (settlement) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].type !== 'assistant') continue;
          (messages[index] as unknown as { tokenUsage?: TurnTokenUsage }).tokenUsage = settlement;
          break;
        }
      }
      return messages;
    });
    return { messages, ...(history.contextUsage ? { contextUsage: history.contextUsage } : {}) };
  }

  async rename(threadId: string, name: string): Promise<void> {
    await this.manager.request('thread/name/set', { threadId, name });
  }

  async fork(threadId: string): Promise<string> {
    const response = await this.manager.request<{ thread: { id: string } }>('thread/fork', { threadId });
    return response.thread.id;
  }

  async archive(threadId: string): Promise<void> {
    await this.manager.request('thread/archive', { threadId });
  }

  async listSubagents(parentThreadId: string, cwd: string): Promise<Thread[]> {
    const children: Thread[] = [];
    let cursor: string | null = null;
    do {
      const response: ThreadListResponse = await this.manager.request<ThreadListResponse>('thread/list', {
        cursor,
        limit: 100,
        cwd,
        useStateDbOnly: true,
      });
      children.push(...response.data.filter((thread) => thread.parentThreadId === parentThreadId));
      cursor = response.nextCursor;
    } while (cursor);
    return children;
  }
}

function mapItem(threadId: string, item: ThreadItem): SessionMessage[] {
  if (item.type === 'userMessage') {
    const text = item.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return [{ type: 'user', session_id: threadId, message: { role: 'user', content: text } } as SessionMessage];
  }
  if (item.type === 'agentMessage') {
    return [{
      type: 'assistant', session_id: threadId, uuid: item.id, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: item.text }] },
    } as unknown as SessionMessage];
  }
  if (item.type === 'reasoning') {
    const thinking = [...item.summary, ...item.content].join('\n');
    if (!thinking) return [];
    return [{
      type: 'assistant', session_id: threadId, uuid: item.id, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
    } as unknown as SessionMessage];
  }
  if (item.type === 'plan') {
    return [{
      type: 'assistant', session_id: threadId, uuid: item.id, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: item.text }] },
    } as unknown as SessionMessage];
  }
  const tool = projectCodexToolItem(item);
  if (tool) {
    return [
      {
        type: 'assistant',
        session_id: threadId,
        uuid: item.id,
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: item.id, name: tool.name, input: tool.input }],
        },
      } as unknown as SessionMessage,
      {
        type: 'user',
        session_id: threadId,
        uuid: `${item.id}:result`,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: item.id,
            content: tool.output,
            is_error: tool.isError,
          }],
        },
      } as unknown as SessionMessage,
    ];
  }
  return [];
}

export const codexSessionService = new CodexSessionService();
