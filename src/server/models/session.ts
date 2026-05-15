export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  sdkSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name: string;
}

export interface UpdateSessionInput {
  name?: string;
  sdkSessionId?: string;
}
