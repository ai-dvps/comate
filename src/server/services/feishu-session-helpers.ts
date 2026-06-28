import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import { chatService } from './chat-service.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';

/**
 * Create a Feishu session for a user, register it, and set it active.
 * Shared by the `/new`/`/clear` text commands, the bot menu, and the
 * session-list card's "新建会话" button so all creation paths stay identical.
 */
export async function createFeishuSessionForUser(
  workspace: Workspace,
  openId: string,
  name?: string,
  botId?: string,
): Promise<ChatSession> {
  const session = await chatService.createSession({
    workspaceId: workspace.id,
    name: name ?? openId,
    source: 'feishu',
    botId,
  });
  workspaceStore.addFeishuUserSession(workspace.id, openId, session.id);
  workspaceStore.setFeishuActiveSession(workspace.id, openId, session.id);
  return session;
}
