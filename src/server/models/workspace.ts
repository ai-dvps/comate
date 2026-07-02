export interface WeComBotIsolationSettings {
  /** Canonical WeCom user ids with the wider skill set. */
  adminUserIds: string[];
  /** Skills allowed to every bot user. */
  defaultAllowedSkills: string[];
  /** Additional skills allowed only to admin users. */
  adminAllowedSkills: string[];
}

export interface WorkspaceSettings {
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomBotEnabled?: boolean;
  wecomBotName?: string;
  wecomCorpId?: string;
  wecomCorpSecret?: string;
  wecomFilePromptTemplate?: string;
  /** Tool permission policy for WeCom bot sessions. When unset, the policy resolves to allow-all (grandfathered if bot enabled, default otherwise). */
  wecomToolPermissions?: import('../services/tool-permission-policy.js').ToolPermissionPolicy;
  /** Per-user isolation policy for WeCom bot sessions. When unset, bot sessions are not restricted by this feature (grandfathered allow-all). */
  wecomBotIsolation?: WeComBotIsolationSettings;
  /** Number of days to retain sent-prompt history for this workspace. Zero or negative disables pruning. */
  promptHistoryRetentionDays?: number;
  /** Configurable glob list of sensitive files that Normal bot users cannot read. Owner/Admin are not constrained. */
  sensitiveFileDenylist?: string[];
  /** Feishu (Lark) bot app credentials and admin list. */
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuEncryptKey?: string;
  feishuVerificationToken?: string;
  feishuBotEnabled?: boolean;
  feishuBotName?: string;
  /** Feishu user IDs allowed to switch the bot's active workspace. */
  feishuAdminUserIds?: string[];
  /** Dead-loop detection thresholds and enablement. When unset, global defaults apply. */
  deadLoopDetection?: DeadLoopDetectionSettings;
}

export interface DeadLoopLine1Settings {
  /** Number of consecutive wasted Read calls before injecting guidance. */
  warnThreshold?: number;
  /** Number of consecutive wasted Read calls before returning cached content. */
  blockThreshold?: number;
}

export interface DeadLoopLine2Settings {
  /** Number of trailing tool_use blocks to scan for repeats. */
  windowSize?: number;
  /** Minimum repeat count of the same tool+params within the window to flag a loop. */
  threshold?: number;
  /** How often to poll subagent transcripts. */
  pollIntervalMs?: number;
  /** How long to wait for the main agent to stop a looping subagent before interrupting. */
  interruptTimeoutMs?: number;
}

export interface DeadLoopDetectionSettings {
  /** Master switch for dead-loop detection in this workspace. Defaults to true. */
  enabled?: boolean;
  line1?: DeadLoopLine1Settings;
  line2?: DeadLoopLine2Settings;
}

export interface Skill {
  name: string;
}

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
}

export interface Hook {
  name: string;
  scriptPath: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  folderPath: string;
  settings: WorkspaceSettings;
  skills: Skill[];
  mcpServers: McpServer[];
  hooks: Hook[];
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  folderPath: string;
  settings?: WorkspaceSettings;
  skills?: Skill[];
  mcpServers?: McpServer[];
  hooks?: Hook[];
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  folderPath?: string;
  settings?: WorkspaceSettings;
  skills?: Skill[];
  mcpServers?: McpServer[];
  hooks?: Hook[];
}
