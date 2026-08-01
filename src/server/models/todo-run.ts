export type TodoRunStatus = 'running' | 'succeeded' | 'failed' | 'missed' | 'skipped';

/** One immutable execution occurrence for a Todo. */
export interface TodoRun {
  id: string;
  todoId: string;
  sessionId: string | null;
  status: TodoRunStatus;
  fireAt: string;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  instructionSnapshot: string;
  createdAt: string;
}

export interface CreateTodoRunInput {
  todoId: string;
  sessionId?: string | null;
  status: TodoRunStatus;
  fireAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  reason?: string | null;
  instructionSnapshot: string;
}

export interface UpdateTodoRunInput {
  sessionId?: string | null;
  status?: TodoRunStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  reason?: string | null;
}
