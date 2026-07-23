export type ApprovalMode = 'auto' | 'readonly' | 'manual';

export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  isDraft?: boolean;
  isWip?: boolean;
  isArchived?: boolean;
  source?: 'gui' | 'wecom' | 'feishu';
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
  /** Bot that created this session, if any. */
  botId?: string;
  createdAt: string;
  updatedAt: string;
  // SDK-derived fields (populated when discovered via listSessions)
  summary?: string;
  lastModified?: number;
  firstPrompt?: string;
  gitBranch?: string;
  customTitle?: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
  approvalMode?: ApprovalMode;
  providerId?: string;
  source?: 'gui' | 'wecom' | 'feishu';
  customTitle?: string;
  /** Bot that created this session, if any. */
  botId?: string;
}

export interface UpdateSessionInput {
  name?: string;
  isWip?: boolean;
  isArchived?: boolean;
  approvalMode?: ApprovalMode;
  providerId?: string;
  fastMode?: boolean;
}
