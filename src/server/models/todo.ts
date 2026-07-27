export type TodoStatus = 'pending' | 'done' | 'discard' | 'did-but-need-verify';

/**
 * Where a todo originated. `local` todos are authoritative in Comate and may be
 * published to a server backend; `github` todos are authoritative on GitHub and
 * synced to a local replica. Future server backends add their own value.
 */
export type TodoOrigin = 'local' | 'github';

export interface Todo {
  id: string;
  /** Global todos may carry no workspace; a workspace is an optional soft link. */
  workspaceId: string | null;
  text: string;
  status: TodoStatus;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  origin: TodoOrigin;
  dueDate: string | null;
  /** Linked GitHub repository (`owner/repo`) for synced todos. */
  repoFullName: string | null;
  /** Linked GitHub issue number for synced todos. */
  issueNumber: number | null;
  /** JSON baseline of the last-seen remote title/body, for conflict detection. */
  remoteSnapshot: string | null;
  remoteUpdatedAt: string | null;
  lastSyncedAt: string | null;
  assignee: string | null;
  labels: string[];
  /** Remote origin was deleted; the local replica is kept for user-confirmed removal. */
  originDeleted: boolean;
}

export interface CreateTodoInput {
  text: string;
  workspaceId?: string | null;
  dueDate?: string | null;
}

export interface UpdateTodoInput {
  text?: string;
  status?: TodoStatus;
  sessionId?: string | null;
  workspaceId?: string | null;
  dueDate?: string | null;
  origin?: TodoOrigin;
  repoFullName?: string | null;
  issueNumber?: number | null;
  remoteSnapshot?: string | null;
  remoteUpdatedAt?: string | null;
  lastSyncedAt?: string | null;
  assignee?: string | null;
  labels?: string[];
  originDeleted?: boolean;
}
