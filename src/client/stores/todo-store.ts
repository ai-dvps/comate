import { create } from 'zustand';
import i18next from 'i18next';

export const MAX_TODO_TEXT_LENGTH = 2000;
/** Cap for the optional markdown content body (KTD2). Title stays at 2000. */
export const MAX_TODO_CONTENT_LENGTH = 50000;

export type TodoStatus = 'pending' | 'done' | 'discard' | 'did-but-need-verify';
export type TodoOrigin = 'local' | 'github';
export type TodoExecutionType = 'manual' | 'once' | 'recurring' | 'idle';
export type TodoExecutionStatus = 'active' | 'paused' | 'disabled';

export interface TodoRun {
  id: string;
  todoId: string;
  sessionId: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'missed' | 'skipped';
  fireAt: string;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  instructionSnapshot: string;
  createdAt: string;
}

export interface Todo {
  id: string;
  workspaceId: string | null;
  text: string;
  /** Optional markdown detail body; mirrors the GitHub issue body (KTD1). */
  content: string | null;
  status: TodoStatus;
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
  deletedAt?: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  origin: TodoOrigin;
  dueDate: string | null;
  repoFullName: string | null;
  issueNumber: number | null;
  remoteSnapshot: string | null;
  remoteUpdatedAt: string | null;
  lastSyncedAt: string | null;
  assignee: string | null;
  labels: string[];
  originDeleted: boolean;
}

export interface CreateTodoOptions {
  workspaceId?: string | null;
  dueDate?: string | null;
  executionType?: TodoExecutionType;
  instruction?: string | null;
  scheduleTime?: string | null;
  cronExpr?: string | null;
}

interface TodoState {
  todos: Todo[];
  isLoading: boolean;
  isSyncing: boolean;
  error: string | null;
  /** Per-repo failures from the last on-demand sync (redacted, safe to show). Null until a sync runs. */
  lastSyncErrors: Array<{ repo: string; message: string }> | null;
  searchQuery: string;

  fetchTodos: () => Promise<void>;
  syncTodos: () => Promise<void>;
  createTodo: (text: string, options?: CreateTodoOptions) => Promise<Todo | null>;
  updateTodo: (todoId: string, patch: Partial<Todo>) => Promise<Todo | null>;
  deleteTodo: (todoId: string) => Promise<boolean>;
  changeStatus: (todoId: string, status: TodoStatus) => Promise<void>;
  setSearchQuery: (query: string) => void;
  getFilteredTodos: () => Todo[];
}

function sortTodos(todos: Todo[]): Todo[] {
  const statusOrder: Record<TodoStatus, number> = {
    pending: 0,
    'did-but-need-verify': 1,
    done: 2,
    discard: 3,
  };
  return [...todos].sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status];
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export const useTodoStore = create<TodoState>((set, get) => ({
  todos: [],
  isLoading: false,
  isSyncing: false,
  error: null,
  lastSyncErrors: null,
  searchQuery: '',

  fetchTodos: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch('/api/todos');
      if (!res.ok) throw new Error(i18next.t('todos:fetchFailed', 'Failed to fetch todos'));
      const data = await res.json();
      set({ todos: sortTodos(data.todos || []), isLoading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error'),
        isLoading: false,
      });
    }
  },

  // On-demand GitHub sync (panel-open / manual refresh). Triggers the
  // server reconcile, then reloads the list so mirrored changes appear (F3).
  syncTodos: async () => {
    set({ isSyncing: true, error: null });
    let syncErrors: Array<{ repo: string; message: string }> | null = null;
    try {
      const res = await fetch('/api/todos/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || i18next.t('todos:syncFailed', 'Failed to sync'));
      }
      const data = (await res.json().catch(() => ({}))) as { sync?: { errors?: Array<{ repo: string; message: string }> } };
      syncErrors = data.sync?.errors && data.sync.errors.length > 0 ? data.sync.errors : [];
    } catch (err) {
      set({ error: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') });
      syncErrors = null;
    } finally {
      // Always reload after a sync attempt so the UI reflects persisted state.
      await get().fetchTodos();
      set({ isSyncing: false, lastSyncErrors: syncErrors });
    }
  },

  createTodo: async (text, options) => {
    const trimmedText = text.trim();
    if (!trimmedText) return null;
    if (trimmedText.length > MAX_TODO_TEXT_LENGTH) {
      console.error('Todo text exceeds maximum length');
      return null;
    }

    const optimistic: Todo = {
      id: `temp-${Date.now()}`,
      workspaceId: options?.workspaceId ?? null,
      text: trimmedText,
      content: null,
      status: 'pending',
      executionType: options?.executionType ?? 'manual',
      instruction: options?.instruction ?? null,
      scheduleTime: options?.scheduleTime ?? null,
      cronExpr: options?.cronExpr ?? null,
      executionStatus: 'active',
      nextFireAt: null,
      notifyDesktop: true,
      notifyInApp: true,
      notifyWecom: false,
      wecomRecipient: null,
      confirmedSnapshot: null,
      deletedAt: null,
      sessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      origin: 'local',
      dueDate: options?.dueDate ?? null,
      repoFullName: null,
      issueNumber: null,
      remoteSnapshot: null,
      remoteUpdatedAt: null,
      lastSyncedAt: null,
      assignee: null,
      labels: [],
      originDeleted: false,
    };

    set((state) => ({ todos: sortTodos([optimistic, ...state.todos]) }));

    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedText,
          workspaceId: options?.workspaceId ?? null,
          dueDate: options?.dueDate ?? null,
          executionType: options?.executionType ?? 'manual',
          instruction: options?.instruction ?? null,
          scheduleTime: options?.scheduleTime ?? null,
          cronExpr: options?.cronExpr ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || i18next.t('todos:createFailed', 'Failed to create todo'));
      }
      const data = await res.json();
      const todo = data.todo as Todo;
      set((state) => ({ todos: sortTodos(state.todos.map((t) => (t.id === optimistic.id ? todo : t))) }));
      return todo;
    } catch (err) {
      set((state) => ({ todos: state.todos.filter((t) => t.id !== optimistic.id) }));
      console.error('Failed to create todo:', err);
      return null;
    }
  },

  updateTodo: async (todoId, patch) => {
    const old = get().todos.find((t) => t.id === todoId);
    if (!old) return null;

    if (patch.text !== undefined && patch.text.trim().length > MAX_TODO_TEXT_LENGTH) {
      console.error('Todo text exceeds maximum length');
      return null;
    }

    const optimistic: Todo = { ...old, ...patch, updatedAt: new Date().toISOString() };
    set((state) => ({ todos: sortTodos(state.todos.map((t) => (t.id === todoId ? optimistic : t))) }));

    try {
      const res = await fetch(`/api/todos/${todoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || i18next.t('todos:updateFailed', 'Failed to update todo'));
      }
      const data = await res.json();
      const todo = data.todo as Todo;
      set((state) => ({ todos: sortTodos(state.todos.map((t) => (t.id === todoId ? todo : t))) }));
      return todo;
    } catch (err) {
      set((state) => ({ todos: sortTodos(state.todos.map((t) => (t.id === todoId ? old : t))) }));
      console.error('Failed to update todo:', err);
      return null;
    }
  },

  deleteTodo: async (todoId) => {
    const old = get().todos.find((t) => t.id === todoId);
    if (!old) return false;

    set((state) => ({ todos: state.todos.filter((t) => t.id !== todoId) }));
    try {
      const res = await fetch(`/api/todos/${todoId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(i18next.t('todos:deleteFailed', 'Failed to delete todo'));
      return true;
    } catch (err) {
      set((state) => ({ todos: sortTodos([...state.todos, old]) }));
      console.error('Failed to delete todo:', err);
      return false;
    }
  },

  changeStatus: async (todoId, status) => {
    await get().updateTodo(todoId, { status });
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  getFilteredTodos: () => {
    const { todos, searchQuery } = get();
    const query = searchQuery.trim().toLowerCase();
    if (!query) return todos;
    return todos.filter((t) => t.text.toLowerCase().includes(query));
  },
}));
