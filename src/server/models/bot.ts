import type { ToolPermissionPolicy } from '../services/tool-permission-policy.js';

export type BotChannel = 'wecom' | 'feishu';

export type BotRole = 'owner' | 'admin' | 'normal';

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

export interface BotMember {
  botId: string;
  channel: BotChannel;
  channelUserId: string;
  role: BotRole;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  name: string;
  activeWorkspaceId: string | null;
  channelSettings: BotChannelSettings;
  rolePolicy: BotRolePolicy;
  persona?: BotPersona;
  rolePersonas?: Partial<Record<BotRole, BotPersona>>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotInput {
  name: string;
  activeWorkspaceId?: string;
  channelSettings?: BotChannelSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona;
  rolePersonas?: Partial<Record<BotRole, BotPersona>>;
}

export interface UpdateBotInput {
  name?: string;
  activeWorkspaceId?: string | null;
  channelSettings?: BotChannelSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona | null;
  rolePersonas?: Partial<Record<BotRole, BotPersona>> | null;
}

export interface CreateBotMemberInput {
  channel: BotChannel;
  channelUserId: string;
  role: BotRole;
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
