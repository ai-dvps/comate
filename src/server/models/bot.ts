import type { ToolPermissionPolicy } from '../services/tool-permission-policy.js';

export type BotProvider = 'wecom' | 'feishu';

export type BotRole = 'owner' | 'admin' | 'normal';

export interface WeComProviderConfig {
  botId?: string;
  botSecret?: string;
  botName?: string;
  corpId?: string;
  corpSecret?: string;
  enabled?: boolean;
}

export interface FeishuProviderConfig {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  botName?: string;
  enabled?: boolean;
}

export interface BotProviderSettings {
  wecom?: WeComProviderConfig;
  feishu?: FeishuProviderConfig;
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
  provider: BotProvider;
  providerUserId: string;
  role: BotRole;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  name: string;
  activeWorkspaceId: string | null;
  providerSettings: BotProviderSettings;
  rolePolicy: BotRolePolicy;
  persona?: BotPersona;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotInput {
  name: string;
  activeWorkspaceId?: string;
  providerSettings?: BotProviderSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona;
}

export interface UpdateBotInput {
  name?: string;
  activeWorkspaceId?: string | null;
  providerSettings?: BotProviderSettings;
  rolePolicy?: BotRolePolicy;
  persona?: BotPersona | null;
}

export interface CreateBotMemberInput {
  provider: BotProvider;
  providerUserId: string;
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

/** Keys within provider configs whose values must be encrypted at rest. */
export const ENCRYPTED_PROVIDER_KEYS: ReadonlyArray<string> = [
  'botSecret',
  'corpSecret',
  'appSecret',
  'encryptKey',
  'verificationToken',
];
