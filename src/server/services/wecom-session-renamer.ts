import { store as workspaceStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import type { ChatSession } from '../models/session.js';

export class WeComSessionRenamer {
  async renameSessionsForUser(workspaceId: string, encryptedUserId: string): Promise<void> {
    const plaintextUserId = workspaceStore.getWecomUserMapping(encryptedUserId);
    if (!plaintextUserId) return;

    const sessionMappings = workspaceStore.listWecomSessionsByUser(workspaceId, encryptedUserId);
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
        ? `${plaintextUserId} session`
        : `${plaintextUserId} session #${i + 1}`;

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
    const mappings = workspaceStore.listWecomSessionsForBackfill();
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
      const plaintextUserId = workspaceStore.getWecomUserMapping(encryptedUserId);
      if (!plaintextUserId) continue;

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
          ? `${plaintextUserId} session`
          : `${plaintextUserId} session #${i + 1}`;

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

  private isEligibleForRename(session: ChatSession): boolean {
    // Only WeCom sessions
    if (session.source !== 'wecom') return false;
    // Skip sessions with user-set custom titles
    if (session.customTitle) return false;
    return true;
  }
}

export const wecomSessionRenamer = new WeComSessionRenamer();
