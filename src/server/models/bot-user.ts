import type { BotRoleKey } from './bot.js';

export interface BotUser {
  id: string;
  botId: string;
  channelId: string;
  roleId: string;
  channelUserId: string;
  plaintextUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived from the linked role row for backward-compatible checks. */
  roleKey: BotRoleKey;
  /** Derived from whether a plaintext user id has been resolved. */
  resolutionStatus: 'resolved' | 'pending';
}

export interface CreateBotUserInput {
  botId: string;
  channelId: string;
  roleId: string;
  channelUserId: string;
  plaintextUserId?: string | null;
}

export interface UpdateBotUserInput {
  roleId?: string;
  plaintextUserId?: string | null;
}

export interface UserSession {
  id: string;
  workspaceId: string;
  sessionId: string;
  userId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserSessionInput {
  workspaceId: string;
  sessionId: string;
  userId: string;
  isActive?: boolean;
}
