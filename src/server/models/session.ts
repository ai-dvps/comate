export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  isDraft?: boolean;
  isWip?: boolean;
  source?: 'gui' | 'wecom';
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
}

export interface UpdateSessionInput {
  name?: string;
  isWip?: boolean;
}
