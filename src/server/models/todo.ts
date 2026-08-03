export type TodoStatus = 'pending' | 'done' | 'discard' | 'did-but-need-verify';
export type TodoExecutionType = 'manual' | 'once' | 'recurring' | 'idle';
/** Whether automatic dispatch is allowed. This is intentionally independent
 * from the human lifecycle (`status`). */
export type TodoExecutionStatus = 'active' | 'paused' | 'disabled';

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
  /**
   * Optional markdown detail body. The existing `text` field remains the short
   * title and session-name source (KTD1); `content` is a distinct, larger,
   * nullable field that mirrors the GitHub issue body for github-origin todos.
   */
  content: string | null;
  status: TodoStatus;
  /** Execution policy is local metadata and never changes GitHub issue state. */
  executionType: TodoExecutionType;
  /** Self-contained instruction used for an automated Run. */
  instruction: string | null;
  scheduleTime: string | null;
  cronExpr: string | null;
  executionStatus: TodoExecutionStatus;
  nextFireAt: string | null;
  notifyDesktop: boolean;
  notifyInApp: boolean;
  notifyWecom: boolean;
  wecomRecipient: string | null;
  /** Opaque workspace/capability snapshot captured for automated execution. */
  confirmedSnapshot: unknown | null;
  /** Retained only for the legacy scheduled-task compatibility window. */
  deletedAt: string | null;
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
  content?: string | null;
  workspaceId?: string | null;
  dueDate?: string | null;
  executionType?: TodoExecutionType;
  instruction?: string | null;
  scheduleTime?: string | null;
  cronExpr?: string | null;
  executionStatus?: TodoExecutionStatus;
  nextFireAt?: string | null;
  notifyDesktop?: boolean;
  notifyInApp?: boolean;
  notifyWecom?: boolean;
  wecomRecipient?: string | null;
  confirmedSnapshot?: unknown | null;
}

export interface UpdateTodoInput {
  text?: string;
  content?: string | null;
  status?: TodoStatus;
  sessionId?: string | null;
  workspaceId?: string | null;
  dueDate?: string | null;
  executionType?: TodoExecutionType;
  instruction?: string | null;
  scheduleTime?: string | null;
  cronExpr?: string | null;
  executionStatus?: TodoExecutionStatus;
  nextFireAt?: string | null;
  notifyDesktop?: boolean;
  notifyInApp?: boolean;
  notifyWecom?: boolean;
  wecomRecipient?: string | null;
  confirmedSnapshot?: unknown | null;
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

/**
 * A comment on a todo. Append-only both directions (R10): `local` comments are
 * pushed to the GitHub issue on the next sync; `github` comments are pulled and
 * mirrored locally. Merged by `remoteId` for github-origin comments.
 */
export interface TodoComment {
  id: string;
  todoId: string;
  origin: 'local' | 'github';
  /** GitHub comment id when origin is github; null for local-only comments. */
  remoteId: number | null;
  author: string;
  body: string;
  createdAt: string;
  /** Local comments not yet pushed outward to the GitHub issue. */
  pushed: boolean;
}

/**
 * A structural-field conflict (R11): both origin and remote edited `title` or
 * `body` since the last-seen baseline. U5 detects and records these; U6
 * surfaces accept-local/accept-remote and clears them. The field is left
 * unchanged (the local value) until the user resolves.
 */
export interface TodoConflict {
  todoId: string;
  field: 'title' | 'body';
  localValue: string;
  remoteValue: string;
  baselineValue: string | null;
  detectedAt: string;
}
