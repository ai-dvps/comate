import type { ToolPermissionPolicy } from '../services/tool-permission-policy.js';

export type BotChannelKey = 'wecom' | 'feishu';

export type BotRoleKey = 'owner' | 'admin' | 'normal';

export interface WeComChannelConfig {
  botId?: string;
  botSecret?: string;
  botName?: string;
  corpId?: string;
  corpSecret?: string;
  enabled?: boolean;
}

export interface FeishuChannelConfig {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  botName?: string;
  enabled?: boolean;
}

export interface BotChannelSettings {
  wecom?: WeComChannelConfig;
  feishu?: FeishuChannelConfig;
}

export interface BotRolePolicy {
  /** Tool permission policy applied to Normal users. Owner/Admin bypass this. */
  normalToolPolicy: ToolPermissionPolicy;
  /** Skill allowlist for Normal users. Owner/Admin bypass this. */
  skillAllowlist: string[];
  /** Bash command whitelist for Normal users. Owner/Admin bypass this. */
  bashWhitelist: string[];
}

export type BotPersonaMode = 'append' | 'replace';

export interface BotPersona {
  prompt: string;
  mode: BotPersonaMode;
}

export interface BotChannel {
  id: string;
  botId: string;
  channelKey: BotChannelKey;
  displayName: string;
  config: BotChannelSettings;
  createdAt: string;
  updatedAt: string;
}

export interface BotRole {
  id: string;
  botId: string;
  roleKey: BotRoleKey;
  permissions: BotRolePolicy;
  persona?: BotPersona;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  name: string;
  activeWorkspaceId: string | null;
  persona?: BotPersona;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotInput {
  name: string;
  activeWorkspaceId?: string;
  persona?: BotPersona;
}

export interface UpdateBotInput {
  name?: string;
  activeWorkspaceId?: string | null;
  persona?: BotPersona | null;
}

export interface BotAuditLogEntry {
  id: string;
  botId: string;
  actorType: 'system' | 'user' | 'wecom' | 'feishu';
  actorId: string;
  eventType: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CreateBotAuditLogInput {
  botId: string;
  actorType: BotAuditLogEntry['actorType'];
  actorId: string;
  eventType: string;
  details?: Record<string, unknown>;
}

/** Keys within channel configs whose values must be encrypted at rest. */
export const ENCRYPTED_CHANNEL_KEYS: ReadonlyArray<string> = [
  'botSecret',
  'corpSecret',
  'appSecret',
  'encryptKey',
  'verificationToken',
];
