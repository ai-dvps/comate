import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { nextCronFire } from './cron-schedule.js';
import { todoExecutionService, type TodoExecutionService } from './todo-execution-service.js';
import type { Todo } from '../models/todo.js';
import { getNightWindow } from './todo-app-settings.js';

const TICK_MS = 30_000;
export const TODO_RUN_RETENTION_DAYS = 90;

interface Deps {
  store?: SqliteStore;
  execution?: Pick<TodoExecutionService, 'runNow'>;
  now?: () => Date;
  hasExecutingSession?: () => boolean;
}

function inWindow(now: Date, start: string, end: string): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const parse = (value: string): number => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const from = parse(start);
  const to = parse(end);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}

/** Scheduler only selects eligible Todos; all session and Run creation belongs
 * to TodoExecutionService. */
export class TodoSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly store: SqliteStore;
  private readonly execution: Pick<TodoExecutionService, 'runNow'>;
  private readonly now: () => Date;
  private readonly hasExecutingSession: () => boolean;

  constructor(deps: Deps = {}) {
    this.store = deps.store ?? defaultStore;
    this.execution = deps.execution ?? todoExecutionService;
    this.now = deps.now ?? (() => new Date());
    this.hasExecutingSession = deps.hasExecutingSession ?? (() => chatService.hasExecutingRuntime());
  }

  initialize(): void {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recomputeNextFire(todo: Todo): string | null {
    if (todo.executionType === 'once') return todo.scheduleTime && new Date(todo.scheduleTime) > this.now() ? todo.scheduleTime : null;
    if (todo.executionType === 'recurring' && todo.cronExpr) return nextCronFire(todo.cronExpr, this.now())?.toISOString() ?? null;
    return null;
  }

  async reconcile(): Promise<void> {
    const now = this.now();
    this.store.pruneTodoRunsOlderThan(new Date(now.getTime() - TODO_RUN_RETENTION_DAYS * 86400000).toISOString());
    for (const run of this.store.listStaleRunningTodoRuns(new Date(now.getTime() - 30 * 60 * 1000).toISOString())) {
      this.store.updateTodoRun(run.id, { status: 'failed', endedAt: now.toISOString(), reason: '进程重启或执行超时' });
    }
    for (const todo of this.automatedTodos()) {
      if (todo.executionType === 'idle') continue;
      const next = this.recomputeNextFire(todo);
      // A missed one-shot occurrence is visible history and is never retried.
      if (todo.executionType === 'once' && todo.scheduleTime && new Date(todo.scheduleTime) <= now) {
        if (!this.store.getLatestTodoRun(todo.id)) {
          this.store.createTodoRun({ todoId: todo.id, status: 'missed', fireAt: todo.scheduleTime, endedAt: now.toISOString(), reason: '触发时应用未运行', instructionSnapshot: todo.instruction ?? todo.text });
        }
        this.store.updateTodo(todo.id, { executionStatus: 'disabled', nextFireAt: null });
      } else {
        this.store.updateTodo(todo.id, { nextFireAt: next });
      }
    }
  }

  private automatedTodos(): Todo[] {
    return this.store.getAllTodos().filter((todo) => todo.status === 'pending' && !todo.deletedAt && todo.executionStatus === 'active' && todo.executionType !== 'manual');
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const scheduled = this.automatedTodos().filter((todo) => todo.executionType === 'once' || todo.executionType === 'recurring');
      for (const todo of scheduled) {
        if (!todo.nextFireAt || new Date(todo.nextFireAt) > now) continue;
        // Advance before dispatch: a process crash cannot cause duplicate fire.
        this.store.updateTodo(todo.id, todo.executionType === 'once'
          ? { executionStatus: 'disabled', nextFireAt: null }
          : { nextFireAt: this.recomputeNextFire(todo) });
        await this.execution.runNow(todo.id, todo.nextFireAt).catch(() => undefined);
      }

      const window = await getNightWindow();
      if (!window.enabled || !inWindow(now, window.start, window.end) || this.hasExecutingSession()) return;
      const idle = this.automatedTodos()
        // Legacy/global items may predate route validation. Keep them active
        // and visible for repair instead of disabling them before runNow
        // rejects the missing workspace.
        .filter((todo) => todo.executionType === 'idle' && todo.workspaceId)
        .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt));
      const next = idle[0];
      if (!next) return;
      // This makes an idle failure a single attempted occurrence, never an
      // automatic next-night retry. A user can still re-enable or run it.
      this.store.updateTodo(next.id, { executionStatus: 'disabled' });
      await this.execution.runNow(next.id, now.toISOString()).catch(() => undefined);
    } finally {
      this.ticking = false;
    }
  }

  async tickForTest(): Promise<void> { await this.tick(); }
}

export const todoSchedulerService = new TodoSchedulerService();
