import type { Workspace } from '../models/workspace.js';
import type { ChatSession } from '../models/session.js';
import { chatService } from './chat-service.js';
import { botService } from './bot-service.js';
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
  const resolvedBotId = botId ?? botService.getBotForWorkspace(workspace.id)?.id;
  if (!resolvedBotId) {
    throw new Error(`No bot bound to workspace ${workspace.id}`);
  }
  const botUser = botService.ensureMember(resolvedBotId, 'feishu', openId);
  workspaceStore.addUserSession(workspace.id, session.id, botUser.id);
  workspaceStore.setActiveUserSession(botUser.id, session.id);
  return session;
}
