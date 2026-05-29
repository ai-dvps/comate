import { create } from 'zustand';
import i18next from 'i18next';

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

interface TodoState {
  todosByWorkspace: Record<string, Todo[]>;
  isLoading: Record<string, boolean>;
  error: Record<string, string | null>;
  searchQuery: string;

  fetchTodos: (workspaceId: string) => Promise<void>;
  createTodo: (workspaceId: string, text: string, detail?: string) => Promise<Todo | null>;
  updateTodo: (todoId: string, patch: Partial<Pick<Todo, 'text' | 'detail' | 'status' | 'sessionId'>>) => Promise<Todo | null>;
  deleteTodo: (todoId: string) => Promise<boolean>;
  changeStatus: (todoId: string, status: TodoStatus) => Promise<void>;
  setSearchQuery: (query: string) => void;
  getFilteredTodos: (workspaceId: string) => Todo[];
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
  todosByWorkspace: {},
  isLoading: {},
  error: {},
  searchQuery: '',

  fetchTodos: async (workspaceId: string) => {
    set((state) => ({
      isLoading: { ...state.isLoading, [workspaceId]: true },
      error: { ...state.error, [workspaceId]: null },
    }));
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/todos`);
      if (!res.ok) throw new Error(i18next.t('common:failedToFetchTodos', 'Failed to fetch todos'));
      const data = await res.json();
      set((state) => ({
        todosByWorkspace: { ...state.todosByWorkspace, [workspaceId]: sortTodos(data.todos || []) },
        isLoading: { ...state.isLoading, [workspaceId]: false },
      }));
    } catch (err) {
      set((state) => ({
        error: { ...state.error, [workspaceId]: err instanceof Error ? err.message : i18next.t('common:unknownError', 'Unknown error') },
        isLoading: { ...state.isLoading, [workspaceId]: false },
      }));
    }
  },

  createTodo: async (workspaceId: string, text: string, detail?: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return null;

    const optimisticTodo: Todo = {
      id: `temp-${Date.now()}`,
      workspaceId,
      text: trimmedText,
      detail: detail?.trim() ?? '',
      status: 'pending',
      sessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    set((state) => ({
      todosByWorkspace: {
        ...state.todosByWorkspace,
        [workspaceId]: sortTodos([optimisticTodo, ...(state.todosByWorkspace[workspaceId] || [])]),
      },
    }));

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmedText, detail: detail?.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || i18next.t('common:failedToCreateTodo', 'Failed to create todo'));
      }
      const data = await res.json();
      const todo = data.todo as Todo;
      set((state) => ({
        todosByWorkspace: {
          ...state.todosByWorkspace,
          [workspaceId]: sortTodos(
            (state.todosByWorkspace[workspaceId] || []).map((t) => (t.id === optimisticTodo.id ? todo : t))
          ),
        },
      }));
      return todo;
    } catch (err) {
      // Revert optimistic update
      set((state) => ({
        todosByWorkspace: {
          ...state.todosByWorkspace,
          [workspaceId]: (state.todosByWorkspace[workspaceId] || []).filter((t) => t.id !== optimisticTodo.id),
        },
      }));
      console.error('Failed to create todo:', err);
      return null;
    }
  },

  updateTodo: async (todoId: string, patch) => {
    const workspaces = get().todosByWorkspace;
    let workspaceId: string | null = null;
    let oldTodo: Todo | null = null;

    for (const [wsId, todos] of Object.entries(workspaces)) {
      const todo = todos.find((t) => t.id === todoId);
      if (todo) {
        workspaceId = wsId;
        oldTodo = todo;
        break;
      }
    }

    if (!workspaceId || !oldTodo) return null;

    const optimisticTodo: Todo = { ...oldTodo, ...patch, updatedAt: new Date().toISOString() };

    set((state) => ({
      todosByWorkspace: {
        ...state.todosByWorkspace,
        [workspaceId!]: sortTodos(
          (state.todosByWorkspace[workspaceId!] || []).map((t) => (t.id === todoId ? optimisticTodo : t))
        ),
      },
    }));

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/todos/${todoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || i18next.t('common:failedToUpdateTodo', 'Failed to update todo'));
      }
      const data = await res.json();
      const todo = data.todo as Todo;
      set((state) => ({
        todosByWorkspace: {
          ...state.todosByWorkspace,
          [workspaceId!]: sortTodos(
            (state.todosByWorkspace[workspaceId!] || []).map((t) => (t.id === todoId ? todo : t))
          ),
        },
      }));
      return todo;
    } catch (err) {
      // Revert optimistic update
      set((state) => ({
        todosByWorkspace: {
          ...state.todosByWorkspace,
          [workspaceId!]: sortTodos(
            (state.todosByWorkspace[workspaceId!] || []).map((t) => (t.id === todoId ? oldTodo! : t))
          ),
        },
      }));
      console.error('Failed to update todo:', err);
      return null;
    }
  },

  deleteTodo: async (todoId: string) => {
    const workspaces = get().todosByWorkspace;
    let workspaceId: string | null = null;
    let oldTodo: Todo | null = null;

    for (const [wsId, todos] of Object.entries(workspaces)) {
      const todo = todos.find((t) => t.id === todoId);
      if (todo) {
        workspaceId = wsId;
        oldTodo = todo;
        break;
      }
    }

    if (!workspaceId || !oldTodo) return false;

    set((state) => ({
      todosByWorkspace: {
        ...state.todosByWorkspace,
        [workspaceId!]: (state.todosByWorkspace[workspaceId!] || []).filter((t) => t.id !== todoId),
      },
    }));

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/todos/${todoId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(i18next.t('common:failedToDeleteTodo', 'Failed to delete todo'));
      return true;
    } catch (err) {
      // Revert optimistic delete
      set((state) => ({
        todosByWorkspace: {
          ...state.todosByWorkspace,
          [workspaceId!]: sortTodos([...(state.todosByWorkspace[workspaceId!] || []), oldTodo!]),
        },
      }));
      console.error('Failed to delete todo:', err);
      return false;
    }
  },

  changeStatus: async (todoId: string, status: TodoStatus) => {
    await get().updateTodo(todoId, { status });
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  getFilteredTodos: (workspaceId: string) => {
    const state = get();
    const todos = state.todosByWorkspace[workspaceId] || [];
    const query = state.searchQuery.trim().toLowerCase();
    if (!query) return todos;
    return todos.filter(
      (t) =>
        t.text.toLowerCase().includes(query) ||
        t.detail.toLowerCase().includes(query)
    );
  },
}));
