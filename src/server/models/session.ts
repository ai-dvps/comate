export type ApprovalMode = 'auto' | 'readonly' | 'manual';

export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  isDraft?: boolean;
  isWip?: boolean;
  source?: 'gui' | 'wecom';
  approvalMode?: ApprovalMode;
  providerId?: string;
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
  source?: 'gui' | 'wecom';
}

export interface UpdateSessionInput {
  name?: string;
  isWip?: boolean;
  approvalMode?: ApprovalMode;
  providerId?: string;
}
