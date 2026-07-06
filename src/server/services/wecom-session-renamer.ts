import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { botService } from './bot-service.js';
import type { ChatSession } from '../models/session.js';

export class WeComSessionRenamer {
  async renameSessionsForUser(workspaceId: string, encryptedUserId: string): Promise<void> {
    const user = this.resolveWecomUser(workspaceId, encryptedUserId);
    if (!user?.plaintextUserId) return;

    const sessionMappings = workspaceStore.listUserSessionsByUser(user.id);
    if (sessionMappings.length === 0) return;

    const sessions: ChatSession[] = [];
    for (const mapping of sessionMappings) {
      const session = workspaceStore.getLocalSession(mapping.sessionId);
      if (session && this.isEligibleForRename(session)) {
        sessions.push(session);
      }
    }

    if (sessions.length === 0) return;

    // Sort by createdAt ASC, with secondary sort by id for determinism
    sessions.sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      if (timeCompare !== 0) return timeCompare;
      return a.id.localeCompare(b.id);
    });

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const title = sessions.length === 1
        ? `${user.plaintextUserId} session`
        : `${user.plaintextUserId} session #${i + 1}`;

      try {
        await chatService.updateSession(session.id, { name: title }, workspaceId);
      } catch (err) {
        console.error(
          `[WeComSessionRenamer] Failed to rename session ${session.id} for user ${encryptedUserId}:`,
          err,
        );
      }
    }
  }

  async backfillExistingSessions(): Promise<void> {
    const mappings = await this.listChannelSessionsForBackfill();
    if (mappings.length === 0) return;

    // Group by (workspaceId, wecomUserId)
    const groups = new Map<string, typeof mappings>();
    for (const mapping of mappings) {
      const key = `${mapping.workspaceId}:${mapping.wecomUserId}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(mapping);
    }

    for (const [key, groupMappings] of groups) {
      const [workspaceId, encryptedUserId] = key.split(':');
      const user = this.resolveWecomUser(workspaceId, encryptedUserId);
      if (!user?.plaintextUserId) continue;

      const sessions: ChatSession[] = [];
      for (const mapping of groupMappings) {
        const session = workspaceStore.getLocalSession(mapping.sessionId);
        if (session && this.isEligibleForRename(session)) {
          sessions.push(session);
        }
      }

      if (sessions.length === 0) continue;

      sessions.sort((a, b) => {
        const timeCompare = a.createdAt.localeCompare(b.createdAt);
        if (timeCompare !== 0) return timeCompare;
        return a.id.localeCompare(b.id);
      });

      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const title = sessions.length === 1
          ? `${user.plaintextUserId} session`
          : `${user.plaintextUserId} session #${i + 1}`;

        try {
          await chatService.updateSession(session.id, { name: title }, workspaceId);
        } catch (err) {
          console.error(
            `[WeComSessionRenamer] Backfill failed to rename session ${session.id} for user ${encryptedUserId}:`,
            err,
          );
        }
      }
    }

    console.log(`[WeComSessionRenamer] Backfill complete, processed ${mappings.length} sessions`);
  }

  private async listChannelSessionsForBackfill(): Promise<Array<{ workspaceId: string; wecomUserId: string; sessionId: string }>> {
    const result: Array<{ workspaceId: string; wecomUserId: string; sessionId: string }> = [];
    for (const workspace of await workspaceStore.list()) {
      for (const sessionMapping of workspaceStore.listBotSessionsForWorkspace(workspace.id)) {
        if (sessionMapping.channelKey !== 'wecom') continue;
        for (const userId of workspaceStore.getSessionUsers(sessionMapping.sessionId)) {
          const botUser = workspaceStore.getBotUser(userId);
          if (!botUser) continue;
          const channel = workspaceStore.getBotChannel(botUser.channelId);
          if (channel?.channelKey === 'wecom') {
            result.push({
              workspaceId: workspace.id,
              wecomUserId: botUser.channelUserId,
              sessionId: sessionMapping.sessionId,
            });
          }
        }
      }
    }
    return result;
  }

  private resolveWecomUser(workspaceId: string, encryptedUserId: string): import('../models/bot-user.js').BotUser | null {
    const bot = botService.getBotForWorkspace(workspaceId);
    if (!bot) return null;
    return botService.getMember(bot.id, 'wecom', encryptedUserId);
  }

  private isEligibleForRename(session: ChatSession): boolean {
    // Only WeCom sessions
    if (session.source !== 'wecom') return false;
    // Skip sessions with user-set custom titles
    if (session.customTitle) return false;
    return true;
  }
}

export const wecomSessionRenamer = new WeComSessionRenamer();
