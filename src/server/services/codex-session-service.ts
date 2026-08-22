import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadItem } from '../generated/codex-protocol/v2/ThreadItem.js';
import type { ThreadReadResponse } from '../generated/codex-protocol/v2/ThreadReadResponse.js';
import type { Thread } from '../generated/codex-protocol/v2/Thread.js';
import type { ThreadListResponse } from '../generated/codex-protocol/v2/ThreadListResponse.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';
import { projectCodexToolItem } from './codex-event-mapper.js';

export class CodexSessionService {
  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  async loadMessages(threadId: string): Promise<SessionMessage[]> {
    const response = await this.manager.request<ThreadReadResponse>('thread/read', { threadId, includeTurns: true });
    return response.thread.turns.flatMap((turn) => turn.items.flatMap((item) => mapItem(threadId, item)));
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
