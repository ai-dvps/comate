import type { ApprovalMode } from './session.js';

export type ScheduleType = 'once' | 'recurring';

export type ScheduledTaskStatus = 'draft' | 'active' | 'paused' | 'disabled';

export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'missed' | 'skipped';

/**
 * Workspace identity + capability scope captured when a draft task is
 * confirmed (KTD-5). The scheduler re-validates the workspace against this
 * snapshot before each fire; drift rejects that run with a recorded reason.
 * Persisted as a JSON string in scheduled_tasks.confirmed_snapshot — the
 * store layer only serializes/parses it, it never interprets the contents.
 */
export interface ConfirmedTaskSnapshot {
  folderPath: string;
  backend: string;
  approvalMode: ApprovalMode;
}

export interface ScheduledTask {
  id: string;
  workspaceId: string;
  name: string;
  instruction: string;
  scheduleType: ScheduleType;
  /** ISO timestamp; set for scheduleType 'once', null otherwise. */
  scheduleTime: string | null;
  /** Cron expression; set for scheduleType 'recurring', null otherwise. */
  cronExpr: string | null;
  notifyDesktop: boolean;
  notifyInApp: boolean;
  notifyWecom: boolean;
  /** WeCom recipient user id; only meaningful when notifyWecom is true. */
  wecomRecipient: string | null;
  status: ScheduledTaskStatus;
  /** Soft-delete marker (KTD-2): row stays, default queries filter it out. */
  deletedAt: string | null;
  confirmedSnapshot: ConfirmedTaskSnapshot | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTaskInput {
  workspaceId: string;
  name: string;
  instruction: string;
  scheduleType: ScheduleType;
  scheduleTime?: string | null;
  cronExpr?: string | null;
  notifyDesktop?: boolean;
  notifyInApp?: boolean;
  notifyWecom?: boolean;
  wecomRecipient?: string | null;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  instruction?: string;
  scheduleType?: ScheduleType;
  scheduleTime?: string | null;
  cronExpr?: string | null;
  notifyDesktop?: boolean;
  notifyInApp?: boolean;
  notifyWecom?: boolean;
  wecomRecipient?: string | null;
  status?: ScheduledTaskStatus;
  confirmedSnapshot?: ConfirmedTaskSnapshot | null;
  nextFireAt?: string | null;
}

export interface ListScheduledTasksOptions {
  workspaceId?: string;
  /** Default false: soft-deleted tasks are excluded from list results. */
  includeDeleted?: boolean;
}

export interface TaskRun {
  id: string;
  taskId: string;
  /** Execution session (KTD-4); null for runs that never started (missed/skipped). */
  sessionId: string | null;
  status: TaskRunStatus;
  /** Scheduled fire time of this run. */
  fireAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Failure/skip reason. */
  reason: string | null;
  /** Instruction (plus wrapper) snapshot at fire time (KTD-10). */
  instructionSnapshot: string;
  createdAt: string;
}

export interface CreateTaskRunInput {
  taskId: string;
  sessionId?: string | null;
  status: TaskRunStatus;
  fireAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  reason?: string | null;
  instructionSnapshot: string;
}

export interface UpdateTaskRunInput {
  sessionId?: string | null;
  status?: TaskRunStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  reason?: string | null;
}
