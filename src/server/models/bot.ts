import type { ToolPermissionPolicy } from '../services/tool-permission-policy.js';
import type { McpServerClassificationOverride } from '../services/mcp-tool-classification.js';

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
  serverUrl?: string;
  botName?: string;
  enabled?: boolean;
}

export interface BotChannelSettings {
  wecom?: WeComChannelConfig;
  feishu?: FeishuChannelConfig;
}

/**
 * Provenance for a passlist rule (KTD-18): who added it and where it came
 * from. `approval` entries are accumulated from "always allow" decisions;
 * `manual` entries are added by a desktop admin.
 */
export interface PasslistRuleProvenance {
  addedBy: string;
  source: 'manual' | 'approval';
  createdAt: string;
}

/**
 * One out-of-sandbox passlist entry (出沙箱直通名单). Stored as an SDK
 * structural rule (e.g. `Bash(git status)`), never a bare prefix string
 * (KTD-13). Exact-match semantics unless a desktop admin edits the rule.
 */
export interface PasslistRule {
  rule: string;
  provenance?: PasslistRuleProvenance;
}

export interface BotRolePolicy {
  /** Tool permission policy applied to Normal users. Owner/Admin bypass this. */
  normalToolPolicy: ToolPermissionPolicy;
  /**
   * @deprecated Legacy per-role skill allowlist. NOT migrated into the new
   * model (KTD-27): the data is kept so old blobs parse, but the new model
   * ignores it. Replaced by bot-level `skills`/`disabledSkills` (R8).
   */
  skillAllowlist: string[];
  /**
   * @deprecated Legacy bash whitelist (string prefix matching). NOT migrated
   * (KTD-27); superseded by `passlistRules` (R7/KTD-13). Kept so old blobs
   * parse.
   */
  bashWhitelist: string[];
  /**
   * Bot-level mounted skill set (R8/KTD-14): the capability surface this bot
   * offers, identical for every role. Absent = all installed skills mounted
   * (the zero-config default); an explicit array = closed mounted set.
   * Individual disables go through `disabledSkills`.
   */
  skills?: string[];
  /** Bot-level explicit skill deny list (KTD-14 backstop). Fail-closed default []. */
  disabledSkills: string[];
  /**
   * Out-of-sandbox passlist (R7/KTD-13): structural rules for commands that
   * may run outside the sandbox without an approval round. Default empty —
   * empty is the correct default (R14).
   */
  passlistRules: PasslistRule[];
  /**
   * Bot-level network domain allowlist (R2/KTD-9), merged over the built-in
   * defaults (WeCom API endpoints + sidecar loopback) at derivation time.
   * Default empty.
   */
  networkAllowlist: string[];
  /**
   * Per-MCP-server classification overrides (U9, KTD-20), keyed by MCP
   * server name: wins over the server's own annotations. Absent = every
   * server classifies by its annotations (unknown → ask). The gate reads
   * this fresh on every call, so edits apply without a runtime rebuild.
   */
  mcpClassification?: Record<string, McpServerClassificationOverride>;
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
