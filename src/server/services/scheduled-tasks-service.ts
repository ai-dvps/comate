import { store, type SqliteStore } from '../storage/sqlite-store.js';
import { schedulerService, SchedulerError, schedulerEvents } from './scheduler-service.js';
import { nextCronFire, parseCron, CronParseError } from './cron-schedule.js';
import { resolveDefaultBackend } from './agent-backends.js';
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  TaskRun,
  UpdateScheduledTaskInput,
} from '../models/scheduled-task.js';

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

export interface TaskWithLatestRun extends ScheduledTask {
  latestRun: TaskRun | null;
}

function computeNextFire(input: {
  scheduleType: 'once' | 'recurring';
  scheduleTime?: string | null;
  cronExpr?: string | null;
}): string | null {
  if (input.scheduleType === 'once') {
    // Deliberately returns a PAST timestamp when the once-time lapsed while
    // the task awaited confirmation: the scheduler's next reconcile turns it
    // into one 'missed' run + disables the task (skip-and-mark, R11) instead
    // of silently stalling it with nextFireAt=null.
    return input.scheduleTime ?? null;
  }
  if (!input.cronExpr) return null;
  const next = nextCronFire(input.cronExpr, new Date());
  return next ? next.toISOString() : null;
}

function validateInput(input: CreateScheduledTaskInput): void {
  if (!input.name?.trim()) throw new TaskValidationError('任务名称不能为空');
  if (!input.instruction?.trim()) throw new TaskValidationError('执行指令不能为空');
  if (input.scheduleType === 'once') {
    if (!input.scheduleTime) throw new TaskValidationError('一次性任务必须指定执行时间');
    const t = new Date(input.scheduleTime);
    if (Number.isNaN(t.getTime())) throw new TaskValidationError('执行时间格式无效');
    if (t <= new Date()) throw new TaskValidationError('执行时间必须是将来的时间');
  } else if (input.scheduleType === 'recurring') {
    if (!input.cronExpr) throw new TaskValidationError('周期任务必须提供调度规则');
    try {
      parseCron(input.cronExpr);
    } catch (err) {
      if (err instanceof CronParseError) throw new TaskValidationError(`调度规则无效：${err.message}`);
      throw err;
    }
    if (!nextCronFire(input.cronExpr, new Date())) {
      throw new TaskValidationError('调度规则在未来一年内没有可触发的时间');
    }
  } else {
    throw new TaskValidationError(`未知的调度类型：${String(input.scheduleType)}`);
  }
}

/**
 * Shared service layer for scheduled-task management. Tasks are active at
 * creation — every surface (local form, chat MCP tool, WeCom bot) creates
 * through here and captures the workspace snapshot at creation time.
 */
export class ScheduledTasksService {
  constructor(private readonly store: SqliteStore) {}

  /**
   * The single creation path: validate, create active, capture the workspace
   * identity + capability snapshot, compute the first fire time, and emit
   * task-created so the panel refreshes (and the user sees chat-created tasks).
   */
  async createTask(workspaceId: string, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    validateInput(input);
    const workspace = await this.store.get(workspaceId);
    if (!workspace) throw new SchedulerError('NOT_FOUND', '任务所属工作区不存在');
    const backend = (await resolveDefaultBackend()).backend;
    const task = this.store.createScheduledTask({ ...input, workspaceId });
    const created = this.store.updateScheduledTask(task.id, {
      confirmedSnapshot: { folderPath: workspace.folderPath, backend, approvalMode: 'auto' },
      nextFireAt: computeNextFire(task),
    })!;
    schedulerEvents.emit('task-created', {
      taskId: created.id,
      taskName: created.name,
      workspaceId,
    });
    return created;
  }

  listTasks(workspaceId?: string): TaskWithLatestRun[] {
    const tasks = this.store.listScheduledTasks(workspaceId ? { workspaceId } : {});
    if (workspaceId) {
      // Workspace-scoped callers (e.g. the MCP list tool) avoid the global
      // latest-runs scan; per-task lookups are index-served LIMIT 1.
      return tasks.map((t) => ({ ...t, latestRun: this.store.getLatestTaskRun(t.id) }));
    }
    const latest = new Map(this.store.latestRunsPerTask().map((r) => [r.taskId, r]));
    return tasks.map((t) => ({ ...t, latestRun: latest.get(t.id) ?? null }));
  }

  /**
   * Workspace-ownership guard (cross-workspace access returns NOT_FOUND, never
   * a 403, so task ids in other workspaces are not even confirmed to exist).
   * Workspace-scoped callers (REST /:taskId* handlers, MCP tools) must go
   * through this instead of the unscoped getTask.
   */
  requireTaskInWorkspace(taskId: string, expectedWorkspaceId: string): ScheduledTask {
    const task = this.getTask(taskId);
    if (task.workspaceId !== expectedWorkspaceId) {
      throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    }
    return task;
  }

  getTask(taskId: string): ScheduledTask {
    const task = this.store.getScheduledTask(taskId);
    if (!task || task.deletedAt) throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    return task;
  }

  updateTask(taskId: string, input: UpdateScheduledTaskInput, expectedWorkspaceId?: string): ScheduledTask {
    const task = expectedWorkspaceId
      ? this.requireTaskInWorkspace(taskId, expectedWorkspaceId)
      : this.getTask(taskId);
    if (input.status && input.status !== task.status) {
      // Status transitions are limited to active ↔ paused; disabled is
      // terminal and set only by the scheduler.
      const allowed =
        (task.status === 'active' && input.status === 'paused') ||
        (task.status === 'paused' && input.status === 'active');
      if (!allowed) {
        throw new TaskValidationError('非法的任务状态变更：已停用任务不可再变更');
      }
    }
    if (input.scheduleType || input.scheduleTime !== undefined || input.cronExpr !== undefined) {
      validateInput({
        workspaceId: task.workspaceId,
        name: input.name ?? task.name,
        instruction: input.instruction ?? task.instruction,
        scheduleType: input.scheduleType ?? task.scheduleType,
        scheduleTime: input.scheduleTime !== undefined ? input.scheduleTime : task.scheduleTime,
        cronExpr: input.cronExpr !== undefined ? input.cronExpr : task.cronExpr,
      });
    }
    const merged = { ...task, ...input };
    const update: UpdateScheduledTaskInput = { ...input };
    if (task.status === 'active' || input.status === 'active') {
      update.nextFireAt = computeNextFire(merged);
    }
    if (input.status === 'paused') {
      update.nextFireAt = null;
    }
    const updated = this.store.updateScheduledTask(taskId, update);
    return updated!;
  }

  deleteTask(taskId: string, expectedWorkspaceId?: string): void {
    if (expectedWorkspaceId) {
      this.requireTaskInWorkspace(taskId, expectedWorkspaceId);
    } else {
      this.getTask(taskId);
    }
    this.store.softDeleteScheduledTask(taskId);
  }

  listRuns(taskId: string, expectedWorkspaceId?: string): TaskRun[] {
    if (expectedWorkspaceId) {
      this.requireTaskInWorkspace(taskId, expectedWorkspaceId);
    } else {
      this.getTask(taskId);
    }
    return this.store.listTaskRuns(taskId);
  }

  async runNow(taskId: string, expectedWorkspaceId?: string): Promise<TaskRun> {
    if (expectedWorkspaceId) this.requireTaskInWorkspace(taskId, expectedWorkspaceId);
    return schedulerService.runNow(taskId);
  }
}

export const scheduledTasksService = new ScheduledTasksService(store);
