import { create } from 'zustand';
import type { ScheduledTask, ScheduledTaskStatus, TaskRun } from '@server/models/scheduled-task.js';
import type { SchedulerRunEventPayload } from '@/lib/scheduled-task-events';
import { notifyRunFinished } from '@/lib/notifications';

const API_BASE = '/api';

/** Task row plus its latest run, as returned by the list endpoints. */
export type ScheduledTaskWithLatestRun = ScheduledTask & { latestRun: TaskRun | null };

export interface CreateTaskPayload {
  name: string;
  instruction: string;
  scheduleType: 'once' | 'recurring';
  scheduleTime?: string | null;
  cronExpr?: string | null;
  notifyDesktop: boolean;
  notifyInApp: boolean;
  notifyWecom: boolean;
  wecomRecipient?: string | null;
}

interface ScheduledTaskState {
  tasks: ScheduledTaskWithLatestRun[];
  loading: boolean;
  error: string | null;
  /** Unread completions + new drafts, surfaced as the title-bar badge (R15). */
  unreadCount: number;
  /** Default agent backend, for the degraded-execution notice (R10). */
  defaultBackend: string | null;

  fetchTasks: () => Promise<void>;
  fetchDefaultBackend: () => Promise<void>;
  fetchRuns: (workspaceId: string, taskId: string) => Promise<TaskRun[]>;
  createTask: (workspaceId: string, payload: CreateTaskPayload) => Promise<ScheduledTask>;
  updateTask: (workspaceId: string, taskId: string, patch: Partial<CreateTaskPayload> & { status?: ScheduledTaskStatus }) => Promise<void>;
  deleteTask: (workspaceId: string, taskId: string) => Promise<void>;
  confirmTask: (workspaceId: string, taskId: string) => Promise<void>;
  runNow: (workspaceId: string, taskId: string) => Promise<TaskRun>;
  clearUnread: () => void;
  /** Entry point for the WebSocket `scheduled_task_event` relay. */
  handleSchedulerEvent: (payload: SchedulerRunEventPayload) => void;
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep status-based message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  unreadCount: 0,
  defaultBackend: null,

  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/scheduled-tasks`);
      const body = await parseJson<{ tasks: ScheduledTaskWithLatestRun[] }>(res);
      set({ tasks: body.tasks, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  fetchDefaultBackend: async () => {
    try {
      const res = await fetch(`${API_BASE}/backends/default`);
      const body = await parseJson<{ backend: string }>(res);
      set({ defaultBackend: body.backend });
    } catch {
      // Degraded-notice is best-effort; leave unknown.
    }
  },

  fetchRuns: async (workspaceId, taskId) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks/${taskId}/runs`);
    const body = await parseJson<{ runs: TaskRun[] }>(res);
    return body.runs;
  },

  createTask: async (workspaceId, payload) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await parseJson<{ task: ScheduledTask }>(res);
    await get().fetchTasks();
    return body.task;
  },

  updateTask: async (workspaceId, taskId, patch) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await parseJson(res);
    await get().fetchTasks();
  },

  deleteTask: async (workspaceId, taskId) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks/${taskId}`, {
      method: 'DELETE',
    });
    await parseJson(res);
    await get().fetchTasks();
  },

  confirmTask: async (workspaceId, taskId) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks/${taskId}/confirm`, {
      method: 'POST',
    });
    await parseJson(res);
    await get().fetchTasks();
  },

  runNow: async (workspaceId, taskId) => {
    const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/scheduled-tasks/${taskId}/run-now`, {
      method: 'POST',
    });
    const body = await parseJson<{ run: TaskRun }>(res);
    await get().fetchTasks();
    return body.run;
  },

  clearUnread: () => set({ unreadCount: 0 }),

  handleSchedulerEvent: (payload) => {
    if (payload.kind === 'run-finished' || payload.kind === 'draft-created') {
      set((state) => ({ unreadCount: state.unreadCount + 1 }));
    }
    if (payload.kind === 'run-finished') {
      void notifyRunFinished(payload);
    }
    void get().fetchTasks();
  },
}));
