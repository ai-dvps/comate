export interface WeComBotIsolationSettings {
  /** Canonical WeCom user ids with the wider skill set. */
  adminUserIds: string[];
  /** Skills allowed to every bot user. */
  defaultAllowedSkills: string[];
  /** Additional skills allowed only to admin users. */
  adminAllowedSkills: string[];
}

/**
 * The Steel session-context shape ("sessionContext"): a replayable login
 * snapshot for one site. Cookie entries pass through CDP's Network.Cookie
 * shape verbatim (the vendored Steel export and our Network.setCookies
 * injection speak the same protocol shape). Storage maps are keyed by page
 * hostname (the export shape); values are string maps.
 *
 * SECURITY (KTD-8): this is a live, replayable session token — it must never
 * leave the server. GET workspace responses strip `sessionContext` (keys and
 * metadata only); it is consumed exclusively by the server-side injection
 * path. IndexedDB is deliberately absent: the vendored export captures it
 * for open pages, but v1 reinjection does not support it (R15 scope note —
 * cookie-primary auth plus web storage).
 */
export interface BrowserSessionContext {
  cookies: Array<Record<string, unknown>>;
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}

/** One remembered site: the stored session context plus bookkeeping metadata. */
export interface BrowserSiteAuthEntry {
  sessionContext: BrowserSessionContext;
  createdAt: string;
  updatedAt: string;
  /** Set on the last successful injection (server-side bookkeeping only). */
  lastUsedAt?: string;
}

/**
 * The stripped, client-safe view of a remembered site (values-only-in: the
 * sessionContext value never leaves the server — KTD-8).
 */
export interface BrowserSiteAuthMeta {
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
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
  /**
   * "记住此站点" remembered login contexts, keyed by the PSL site key
   * (eTLD+1; port-scoped for localhost/single-label hosts — see
   * browser-site-key.ts). Values are write-only from the client's
   * perspective: GET responses strip `sessionContext` down to
   * BrowserSiteAuthMeta, and the PUT route never accepts client-supplied
   * values (server-side field-level merge). Bot sessions never receive
   * injections from this store.
   */
  browserSiteAuth?: Record<string, BrowserSiteAuthEntry>;
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
