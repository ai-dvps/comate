import { EventEmitter } from 'node:events';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { nextCronFire } from './cron-schedule.js';
import { diagLog } from '../utils/diag-logger.js';
import type { ScheduledTask, TaskRun, UpdateScheduledTaskInput } from '../models/scheduled-task.js';
import type { ChatSession } from '../models/session.js';
import type { SseEvent } from '../types/message.js';

const TICK_MS = 30_000;
export const SKIP_REASON_PREVIOUS_RUNNING = '上一班次仍在执行';
export const MISS_REASON_APP_NOT_RUNNING = '触发时应用未在运行';
export const FAIL_REASON_PROCESS_RESTART = '进程重启';
export const FAIL_REASON_WORKSPACE_DRIFT = '工作区已变更，需重新确认';

export type SchedulerErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID';

export class SchedulerError extends Error {
  constructor(
    public code: SchedulerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SchedulerError';
  }
}

export interface SchedulerRunEvent {
  taskId: string;
  taskName: string;
  workspaceId: string;
  runId: string;
  sessionId: string | null;
  status?: TaskRun['status'];
  resultText?: string | null;
  reason?: string | null;
}

/**
 * U6's notifier subscribes here: run-started when a run session is created,
 * run-finished on every terminal state (succeeded/failed, and missed/skipped
 * records written without a session).
 */
export const schedulerEvents = new EventEmitter();
schedulerEvents.setMaxListeners(50);

interface ChatLike {
  createSession(input: {
    workspaceId: string;
    name: string;
    source?: string;
    approvalMode?: string;
  }): Promise<ChatSession>;
  pushMessage(
    sessionId: string,
    workspaceId: string,
    message: string,
    isBotSession?: boolean,
    botEventHandler?: (id: number, event: SseEvent) => void,
  ): Promise<void>;
}

interface SchedulerDeps {
  now?: () => Date;
  chat?: ChatLike;
  store?: SqliteStore;
}

/**
 * Scheduler core (KTD-1): a 30s tick fires tasks whose nextFireAt falls inside
 * the current window. No absolute timers — nextFireAt is recomputed after
 * every fire/edit, so a process restart never causes catch-up or double-fire.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly nowFn: () => Date;
  private readonly chat: ChatLike;
  private readonly store: SqliteStore;

  constructor(deps: SchedulerDeps = {}) {
    this.nowFn = deps.now ?? (() => new Date());
    this.chat = deps.chat ?? (chatService as unknown as ChatLike);
    this.store = deps.store ?? defaultStore;
  }

  initialize(): void {
    if (this.timer) return;
    this.reconcile().catch((err) => {
      console.error('[SchedulerService] Reconciliation error:', err);
      diagLog(`[SchedulerService] reconcile error: ${err}`);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    diagLog('[SchedulerService] initialized, tick=' + TICK_MS + 'ms');
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Recompute the next fire time for a task; null when nothing is scheduled. */
  recomputeNextFire(task: ScheduledTask): string | null {
    const now = this.nowFn();
    if (task.scheduleType === 'once') {
      if (!task.scheduleTime) return null;
      return new Date(task.scheduleTime) > now ? task.scheduleTime : null;
    }
    if (!task.cronExpr) return null;
    const next = nextCronFire(task.cronExpr, now);
    return next ? next.toISOString() : null;
  }

  /**
   * Startup reconciliation (KTD-1):
   * (a) overdue tasks get ONE collapsed 'missed' run and a recomputed fire time;
   * (b) runs left 'running' by a previous process are marked failed;
   * (c) nextFireAt is recomputed for all active tasks; missed one-shot tasks
   *     are disabled since their single occurrence is gone.
   */
  async reconcile(): Promise<void> {
    const nowIso = this.nowFn().toISOString();
    for (const run of this.store.latestRunsPerTask()) {
      if (run.status === 'running') {
        this.store.updateTaskRun(run.id, { status: 'failed', endedAt: nowIso, reason: FAIL_REASON_PROCESS_RESTART });
      }
    }
    for (const task of this.store.listScheduledTasks({})) {
      if (task.status !== 'active') continue;
      if (task.nextFireAt && new Date(task.nextFireAt) <= this.nowFn()) {
        const missed = this.store.createTaskRun({
          taskId: task.id,
          status: 'missed',
          fireAt: task.nextFireAt,
          reason: MISS_REASON_APP_NOT_RUNNING,
          instructionSnapshot: task.instruction,
        });
        schedulerEvents.emit('run-finished', {
          taskId: task.id,
          taskName: task.name,
          workspaceId: task.workspaceId,
          runId: missed.id,
          sessionId: null,
          status: 'missed',
          reason: MISS_REASON_APP_NOT_RUNNING,
        } satisfies SchedulerRunEvent);
      }
      const next = this.recomputeNextFire(task);
      const update: UpdateScheduledTaskInput = { nextFireAt: next };
      if (task.scheduleType === 'once' && !next) update.status = 'disabled';
      this.store.updateScheduledTask(task.id, update);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.nowFn();
      const windowStart = now.getTime() - TICK_MS;
      for (const task of this.store.listScheduledTasks({})) {
        if (task.status !== 'active' || !task.nextFireAt) continue;
        const fireAt = new Date(task.nextFireAt).getTime();
        if (fireAt > windowStart && fireAt <= now.getTime()) {
          await this.fireTask(task, task.nextFireAt);
        }
      }
    } catch (err) {
      console.error('[SchedulerService] Tick error:', err);
      diagLog(`[SchedulerService] tick error: ${err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Manual trigger used by the REST route (U5). Rejects drafts/disabled and overlap. */
  async runNow(taskId: string): Promise<TaskRun> {
    const task = this.store.getScheduledTask(taskId);
    if (!task || task.deletedAt) throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    if (task.status === 'draft') throw new SchedulerError('CONFLICT', '任务尚未确认，不能执行');
    if (task.status === 'disabled') throw new SchedulerError('CONFLICT', '一次性任务已执行完成');
    if (this.latestRun(task.id)?.status === 'running') {
      throw new SchedulerError('CONFLICT', SKIP_REASON_PREVIOUS_RUNNING);
    }
    return this.fireTask(task, this.nowFn().toISOString());
  }

  private latestRun(taskId: string): TaskRun | null {
    return this.store.listTaskRuns(taskId)[0] ?? null;
  }

  private async fireTask(task: ScheduledTask, fireAt: string): Promise<TaskRun> {
    const nowIso = this.nowFn().toISOString();

    // Overlap guard (R12): scheduler ticks record a skipped run; manual
    // run-now is rejected earlier in runNow (409 semantics).
    if (this.latestRun(task.id)?.status === 'running') {
      return this.store.createTaskRun({
        taskId: task.id,
        status: 'skipped',
        fireAt,
        reason: SKIP_REASON_PREVIOUS_RUNNING,
        instructionSnapshot: task.instruction,
      });
    }

    // Drift check (KTD-5): the workspace must still match the confirm-time
    // snapshot; drift rejects this run without creating a session.
    const workspace = await this.store.get(task.workspaceId);
    const snapshot = task.confirmedSnapshot;
    if (!workspace || (snapshot && workspace.folderPath !== snapshot.folderPath)) {
      const run = this.store.createTaskRun({
        taskId: task.id,
        status: 'failed',
        fireAt,
        endedAt: nowIso,
        reason: FAIL_REASON_WORKSPACE_DRIFT,
        instructionSnapshot: task.instruction,
      });
      schedulerEvents.emit('run-finished', {
        taskId: task.id,
        taskName: task.name,
        workspaceId: task.workspaceId,
        runId: run.id,
        sessionId: null,
        status: 'failed',
        reason: FAIL_REASON_WORKSPACE_DRIFT,
      } satisfies SchedulerRunEvent);
      return run;
    }

    const wrapped = wrapInstructionForRun(task);
    const session = await this.chat.createSession({
      workspaceId: task.workspaceId,
      name: `${task.name} · ${fireAt.slice(0, 16).replace('T', ' ')}`,
      source: 'scheduled',
      approvalMode: 'auto',
    });
    const run = this.store.createTaskRun({
      taskId: task.id,
      sessionId: session.id,
      status: 'running',
      fireAt,
      startedAt: nowIso,
      instructionSnapshot: wrapped,
    });
    schedulerEvents.emit('run-started', {
      taskId: task.id,
      taskName: task.name,
      workspaceId: task.workspaceId,
      runId: run.id,
      sessionId: session.id,
      status: 'running',
    } satisfies SchedulerRunEvent);

    // Advance the schedule BEFORE dispatching so a crash mid-dispatch leaves a
    // consistent missed-run picture on next startup (KTD-1).
    if (task.scheduleType === 'once') {
      this.store.updateScheduledTask(task.id, { status: 'disabled', nextFireAt: null });
    } else {
      this.store.updateScheduledTask(task.id, { nextFireAt: this.recomputeNextFire(task) });
    }

    const onEvent = (_id: number, event: SseEvent): void => {
      if (event.type === 'result') {
        this.finishRun(run.id, task, session.id, event);
      }
    };
    // isBotSession=false: the run is a normal session — approvalMode 'auto'
    // seeds from the session (chat-service only seeds non-bot runtimes), the
    // backend follows the app default (R10 degradation), and the event
    // handler still receives the result stream (KTD-9).
    this.chat.pushMessage(session.id, task.workspaceId, wrapped, false, onEvent).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.finishRun(run.id, task, session.id, null, reason);
    });
    return run;
  }

  private finishRun(
    runId: string,
    task: ScheduledTask,
    sessionId: string,
    resultEvent: Extract<SseEvent, { type: 'result' }> | null,
    errorReason?: string,
  ): void {
    const failed = errorReason !== undefined || (resultEvent?.isError ?? false);
    const reason = errorReason ?? (failed ? (resultEvent?.result ?? '执行失败') : null);
    this.store.updateTaskRun(runId, {
      status: failed ? 'failed' : 'succeeded',
      endedAt: this.nowFn().toISOString(),
      reason,
    });
    schedulerEvents.emit('run-finished', {
      taskId: task.id,
      taskName: task.name,
      workspaceId: task.workspaceId,
      runId,
      sessionId,
      status: failed ? 'failed' : 'succeeded',
      resultText: resultEvent?.result ?? null,
      reason,
    } satisfies SchedulerRunEvent);
    diagLog(`[SchedulerService] run ${runId} finished: ${failed ? 'failed' : 'succeeded'}`);
  }

  /** Test seam: expose a single tick. */
  async tickForTest(): Promise<void> {
    return this.tick();
  }
}

/**
 * Placeholder for U4's /goal wrapper (KTD-3). Today the instruction goes out
 * as-is; U4 replaces this with the system-wrapped goal condition (instruction +
 * completion standard + turn cap), keeping this seam as the single swap point.
 */
export function wrapInstructionForRun(task: ScheduledTask): string {
  return task.instruction;
}

export const schedulerService = new SchedulerService();
