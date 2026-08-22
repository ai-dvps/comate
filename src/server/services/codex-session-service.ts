import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadItem } from '../generated/codex-protocol/v2/ThreadItem.js';
import type { ThreadReadResponse } from '../generated/codex-protocol/v2/ThreadReadResponse.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';

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
  return [];
}

export const codexSessionService = new CodexSessionService();
