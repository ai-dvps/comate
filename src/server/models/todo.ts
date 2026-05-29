export type TodoStatus = 'pending' | 'done' | 'discard' | 'did-but-need-verify';

export interface Todo {
  id: string;
  workspaceId: string;
  text: string;
  detail: string;
  status: TodoStatus;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  text: string;
  detail?: string;
}

export interface UpdateTodoInput {
  text?: string;
  detail?: string;
  status?: TodoStatus;
  sessionId?: string | null;
}
