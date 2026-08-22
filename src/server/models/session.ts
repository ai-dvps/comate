export type ApprovalMode = 'auto' | 'readonly' | 'manual';

export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  isDraft?: boolean;
  isWip?: boolean;
  isArchived?: boolean;
  source?: 'gui' | 'wecom' | 'feishu' | 'scheduled';
  /**
   * Agent backend this session is locked to (KTD-5/KTD-9). Unset on drafts;
   * written once at first runtime creation and never changed afterwards —
   * transcripts are not portable across runtimes.
   */
  backend?: string;
  /** Backend-side session identifier (opencode ses_*), set at runtime creation for resume. */
  backendSessionId?: string;
  approvalMode?: ApprovalMode;
  providerId?: string;
  fastMode?: boolean;
  codexModel?: string;
  codexEffort?: string;
  codexSpeed?: string;
  /** Bot that created this session, if any. */
  botId?: string;
  createdAt: string;
  updatedAt: string;
  // SDK-derived fields (populated when discovered via listSessions)
  summary?: string;
  lastModified?: number;
  /**
   * Server-persisted MRU ordering key (activity sort position stability, KTD1):
   * epoch ms of the last turn start. Initialized at creation/discovery (KTD4),
   * stamped once per admitted turn; the client treats server-carried values as
   * authoritative. May be absent on rows inserted by a downgraded binary until
   * the next launch's backfill heals them.
   */
  lastTurnStartedAt?: number;
  firstPrompt?: string;
  gitBranch?: string;
  customTitle?: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  approvalMode?: ApprovalMode;
  providerId?: string | null;
  backend?: string;
  fastMode?: boolean;
  codexModel?: string;
  codexEffort?: string;
  codexSpeed?: string;
  source?: 'gui' | 'wecom' | 'feishu' | 'scheduled';
  customTitle?: string;
  /** Bot that created this session, if any. */
  botId?: string;
}

export interface UpdateSessionInput {
  name?: string;
  isWip?: boolean;
  isArchived?: boolean;
  approvalMode?: ApprovalMode;
  providerId?: string | null;
  fastMode?: boolean;
  codexModel?: string | null;
  codexEffort?: string | null;
  codexSpeed?: string | null;
  /** Pre-select the backend on a draft; rejected once the session is locked (R4). */
  backend?: string;
}
