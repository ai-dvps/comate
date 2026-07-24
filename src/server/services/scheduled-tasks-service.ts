import { store, type SqliteStore } from '../storage/sqlite-store.js';
import { schedulerService, SchedulerError } from './scheduler-service.js';
import { nextCronFire, parseCron, CronParseError } from './cron-schedule.js';
import { resolveDefaultBackend } from './agent-backends.js';
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  TaskRun,
  UpdateScheduledTaskInput,
} from '../models/scheduled-task.js';

export class TaskValidationError extends Error {
  readonly statusCode = 400;
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
  const now = new Date();
  if (input.scheduleType === 'once') {
    return input.scheduleTime ?? null;
  }
  if (!input.cronExpr) return null;
  const next = nextCronFire(input.cronExpr, now);
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
 * Shared service layer for scheduled-task management (KTD-5): the REST routes
 * and U7's MCP tools both go through here so the confirm gate and validation
 * rules live in exactly one place.
 */
export class ScheduledTasksService {
  constructor(private readonly store: SqliteStore) {}

  /** Local UI creation (F1): the user fills the form directly — active immediately. */
  async createTask(workspaceId: string, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    validateInput(input);
    const task = this.store.createScheduledTask({ ...input, workspaceId });
    return this.confirmTask(task.id);
  }

  /** Chat/MCP creation (R5/R6): lands as a draft awaiting UI confirmation. */
  createDraft(workspaceId: string, input: CreateScheduledTaskInput): ScheduledTask {
    validateInput(input);
    return this.store.createScheduledTask({ ...input, workspaceId });
  }

  /**
   * Confirm a draft (R6): the only path from draft to active. Captures the
   * workspace identity + capability scope snapshot (KTD-5) and computes the
   * first fire time.
   */
  async confirmTask(taskId: string): Promise<ScheduledTask> {
    const task = this.store.getScheduledTask(taskId);
    if (!task || task.deletedAt) throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    if (task.status !== 'draft') throw new SchedulerError('CONFLICT', '任务已确认');
    const workspace = await this.store.get(task.workspaceId);
    if (!workspace) throw new SchedulerError('NOT_FOUND', '任务所属工作区不存在');
    const backend = (await resolveDefaultBackend()).backend;
    const confirmed = this.store.updateScheduledTask(taskId, {
      status: 'active',
      confirmedSnapshot: { folderPath: workspace.folderPath, backend, approvalMode: 'auto' },
      nextFireAt: computeNextFire(task),
    });
    return confirmed!;
  }

  listTasks(workspaceId?: string): TaskWithLatestRun[] {
    const tasks = this.store.listScheduledTasks(workspaceId ? { workspaceId } : {});
    const latest = new Map(this.store.latestRunsPerTask().map((r) => [r.taskId, r]));
    return tasks.map((t) => ({ ...t, latestRun: latest.get(t.id) ?? null }));
  }

  getTask(taskId: string): ScheduledTask {
    const task = this.store.getScheduledTask(taskId);
    if (!task || task.deletedAt) throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    return task;
  }

  updateTask(taskId: string, input: UpdateScheduledTaskInput): ScheduledTask {
    const task = this.getTask(taskId);
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

  deleteTask(taskId: string): void {
    this.getTask(taskId);
    this.store.softDeleteScheduledTask(taskId);
  }

  listRuns(taskId: string): TaskRun[] {
    this.getTask(taskId);
    return this.store.listTaskRuns(taskId);
  }

  async runNow(taskId: string): Promise<TaskRun> {
    return schedulerService.runNow(taskId);
  }
}

export const scheduledTasksService = new ScheduledTasksService(store);
