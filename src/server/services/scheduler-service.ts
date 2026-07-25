import { EventEmitter } from 'node:events';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { nextCronFire } from './cron-schedule.js';
import { buildGoalPrompt, GOAL_BLOCKED_PREFIX, GOAL_COMPLETE_MARKER } from './goal-wrapper.js';
import { resolveDefaultBackend } from './agent-backends.js';
import { diagLog } from '../utils/diag-logger.js';
import type { ScheduledTask, TaskRun, UpdateScheduledTaskInput } from '../models/scheduled-task.js';
import type { ChatSession } from '../models/session.js';
import type { SseEvent } from '../types/message.js';

const TICK_MS = 30_000;
/** Data lifecycle (KTD-11): run records older than this are physically pruned at startup reconciliation. */
export const RUN_RETENTION_DAYS = 90;
export const SKIP_REASON_PREVIOUS_RUNNING = '上一班次仍在执行';
export const MISS_REASON_APP_NOT_RUNNING = '触发时应用未在运行';
export const FAIL_REASON_PROCESS_RESTART = '进程重启';
export const FAIL_REASON_WORKSPACE_DRIFT = '工作区已变更，需重新确认';
export const FAIL_REASON_WATCHDOG = '执行超时（看门狗）';
export const FAIL_REASON_INCOMPLETE = '未达成完成标准';
/**
 * Watchdog bound for wedged 'running' rows: a stalled provider stream never
 * emits a result event and no evaluator can bound it. The 20-turn cap makes
 * long legitimate runs possible, so the bound is generous.
 */
export const RUN_WATCHDOG_MS = 30 * 60 * 1000;

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
  /** Drift-check seam (KTD-5): current default backend; tests inject a fake. */
  resolveBackend?: () => Promise<string>;
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
  private chatOverride: ChatLike | undefined;
  private readonly store: SqliteStore;
  private readonly resolveBackendFn: () => Promise<string>;
  /** Synchronous run reservation (R12): closes the check-then-act gap between
   * the overlap check and the running-row insert inside fireTask. */
  private readonly inFlight = new Set<string>();

  constructor(deps: SchedulerDeps = {}) {
    this.nowFn = deps.now ?? (() => new Date());
    this.chatOverride = deps.chat;
    this.store = deps.store ?? defaultStore;
    this.resolveBackendFn = deps.resolveBackend ?? (async () => (await resolveDefaultBackend()).backend);
  }

  /**
   * Lazy chatService access: scheduler-service ↔ chat-service form an import
   * cycle (via the MCP/tool chain), so the binding must not be touched during
   * module initialization — only at fire time.
   */
  private chat(): ChatLike {
    if (!this.chatOverride) this.chatOverride = chatService as unknown as ChatLike;
    return this.chatOverride;
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
   * Shared missed-occurrence settlement (KTD-1, KTD-9): write ONE collapsed
   * 'missed' run for the most recent occurrence at or before now, notify, and
   * advance the cursor (one-shot tasks whose single occurrence is gone are
   * disabled). Used by startup reconcile and by the tick overdue branch.
   */
  private markMissedAndAdvance(task: ScheduledTask): void {
    const missed = this.store.createTaskRun({
      taskId: task.id,
      status: 'missed',
      fireAt: this.mostRecentOccurrence(task),
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
    const next = this.recomputeNextFire(task);
    const update: UpdateScheduledTaskInput = { nextFireAt: next };
    if (task.scheduleType === 'once' && !next) update.status = 'disabled';
    this.store.updateScheduledTask(task.id, update);
  }

  /**
   * Most recent occurrence at or before now (KTD-9): for recurring tasks walk
   * the cron forward from the stale cursor to the last occurrence <= now; a
   * one-shot task's stored time IS the occurrence.
   */
  private mostRecentOccurrence(task: ScheduledTask): string {
    if (task.scheduleType === 'once' || !task.cronExpr || !task.nextFireAt) {
      return task.nextFireAt ?? this.nowFn().toISOString();
    }
    const now = this.nowFn();
    let occurrence = new Date(task.nextFireAt);
    for (;;) {
      const next = nextCronFire(task.cronExpr, occurrence);
      if (!next || next > now) break;
      occurrence = next;
    }
    return occurrence.toISOString();
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
    const cutoff = new Date(this.nowFn().getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const pruned = this.store.pruneTaskRunsOlderThan(cutoff);
    if (pruned > 0) diagLog(`[SchedulerService] pruned ${pruned} task runs older than ${RUN_RETENTION_DAYS}d`);
    for (const run of this.store.latestRunsPerTask()) {
      if (run.status === 'running') {
        this.store.updateTaskRun(run.id, { status: 'failed', endedAt: nowIso, reason: FAIL_REASON_PROCESS_RESTART });
      }
    }
    for (const task of this.store.listScheduledTasks({})) {
      if (task.status !== 'active') continue;
      if (task.nextFireAt && new Date(task.nextFireAt) <= this.nowFn()) {
        this.markMissedAndAdvance(task);
        continue;
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
      this.failStaleRuns(now);
      for (const task of this.store.listScheduledTasks({})) {
        if (task.status !== 'active' || !task.nextFireAt) continue;
        const fireAt = new Date(task.nextFireAt).getTime();
        if (fireAt > windowStart && fireAt <= now.getTime()) {
          await this.fireTask(task, task.nextFireAt);
        } else if (fireAt <= windowStart) {
          // Out-of-window past (system sleep / event-loop stall, R11): the
          // occurrence is gone — settle it as missed and advance the cursor so
          // the task is not stranded until the next process restart (KTD-1).
          this.markMissedAndAdvance(task);
        }
      }
    } catch (err) {
      console.error('[SchedulerService] Tick error:', err);
      diagLog(`[SchedulerService] tick error: ${err}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Watchdog: a provider stream that dies without a result event would wedge
   * its run 'running' forever — every later occurrence would skip on the
   * overlap guard with no user signal. chatService.setOnRuntimeClose is
   * single-slot and owned by the WS runtime_closed relay, so there is no cheap
   * early-fail hook; this bounded watchdog is the settlement path.
   */
  private failStaleRuns(now: Date): void {
    const cutoff = new Date(now.getTime() - RUN_WATCHDOG_MS).toISOString();
    for (const run of this.store.listStaleRunningTaskRuns(cutoff)) {
      this.store.updateTaskRun(run.id, {
        status: 'failed',
        endedAt: now.toISOString(),
        reason: FAIL_REASON_WATCHDOG,
      });
      const task = this.store.getScheduledTask(run.taskId);
      schedulerEvents.emit('run-finished', {
        taskId: run.taskId,
        taskName: task?.name ?? run.taskId,
        workspaceId: task?.workspaceId ?? '',
        runId: run.id,
        sessionId: run.sessionId,
        status: 'failed',
        reason: FAIL_REASON_WATCHDOG,
      } satisfies SchedulerRunEvent);
      diagLog(`[SchedulerService] watchdog failed stale run ${run.id}`);
    }
  }

  /** Manual trigger used by the REST route (U5). Rejects drafts/disabled and overlap. */
  async runNow(taskId: string): Promise<TaskRun> {
    const task = this.store.getScheduledTask(taskId);
    if (!task || task.deletedAt) throw new SchedulerError('NOT_FOUND', `Scheduled task ${taskId} not found`);
    if (task.status === 'disabled') throw new SchedulerError('CONFLICT', '一次性任务已执行完成');
    if (this.inFlight.has(task.id) || this.latestRun(task.id)?.status === 'running') {
      throw new SchedulerError('CONFLICT', SKIP_REASON_PREVIOUS_RUNNING);
    }
    return this.fireTask(task, this.nowFn().toISOString());
  }

  private latestRun(taskId: string): TaskRun | null {
    return this.store.getLatestTaskRun(taskId);
  }

  private async fireTask(task: ScheduledTask, fireAt: string): Promise<TaskRun> {
    const nowIso = this.nowFn().toISOString();

    // Overlap guard (R12): the in-flight claim is taken synchronously before
    // any await, so two concurrent triggers cannot both pass the DB latest-run
    // check (check-then-act); the DB check stays as cross-restart defense.
    // Scheduler ticks record a skipped run; manual run-now is rejected earlier
    // in runNow (409 semantics).
    if (this.inFlight.has(task.id) || this.latestRun(task.id)?.status === 'running') {
      return this.store.createTaskRun({
        taskId: task.id,
        status: 'skipped',
        fireAt,
        reason: SKIP_REASON_PREVIOUS_RUNNING,
        instructionSnapshot: task.instruction,
      });
    }
    this.inFlight.add(task.id);
    try {
      // Drift check (KTD-5): the workspace folderPath AND the default backend
      // must still match the confirm-time snapshot; a backend switch changes
      // unattended execution semantics (the claude Stop-hook evaluator only
      // exists on that backend) without re-confirmation, so drift rejects this
      // run without creating a session.
      const workspace = await this.store.get(task.workspaceId);
      const snapshot = task.confirmedSnapshot;
      const backendDrift =
        snapshot && workspace && workspace.folderPath === snapshot.folderPath
          ? (await this.resolveBackendFn()) !== snapshot.backend
          : false;
      if (!workspace || (snapshot && workspace.folderPath !== snapshot.folderPath) || backendDrift) {
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
      // Advance the schedule BEFORE dispatching so a crash mid-dispatch leaves
      // a consistent missed-run picture on next startup (KTD-1). The same
      // settlement applies to dispatch failures so the cursor never strands.
      const advanceSchedule = (): void => {
        if (task.scheduleType === 'once') {
          this.store.updateScheduledTask(task.id, { status: 'disabled', nextFireAt: null });
        } else {
          this.store.updateScheduledTask(task.id, { nextFireAt: this.recomputeNextFire(task) });
        }
      };
      try {
        const session = await this.chat().createSession({
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
        advanceSchedule();

        // The run session stays usable after the run (KTD-4), and its runtime
        // keeps this handler — finalize exactly once so a later result event
        // from a user follow-up cannot rewrite the settled run or re-notify.
        let finished = false;
        const finishOnce = (
          resultEvent: Extract<SseEvent, { type: 'result' }> | null,
          errorReason?: string,
        ): void => {
          if (finished) return;
          finished = true;
          this.finishRun(run.id, task, session.id, resultEvent, errorReason);
        };
        const onEvent = (_id: number, event: SseEvent): void => {
          if (event.type === 'result') {
            finishOnce(event);
          }
        };
        // isBotSession=false: the run is a normal session — approvalMode 'auto'
        // seeds from the session (chat-service only seeds non-bot runtimes), the
        // backend follows the app default (R10 degradation), and the event
        // handler still receives the result stream (KTD-9).
        this.chat().pushMessage(session.id, task.workspaceId, wrapped, false, onEvent).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          finishOnce(null, reason);
        });
        return run;
      } catch (err) {
        // Dispatch failure (createSession/createTaskRun threw): record a failed
        // run and settle the schedule exactly like a completed run (once →
        // disabled; recurring → recompute) so the cursor never strands on a
        // transient error.
        const reason = err instanceof Error ? err.message : String(err);
        const run = this.store.createTaskRun({
          taskId: task.id,
          status: 'failed',
          fireAt,
          endedAt: this.nowFn().toISOString(),
          reason,
          instructionSnapshot: wrapped,
        });
        schedulerEvents.emit('run-finished', {
          taskId: task.id,
          taskName: task.name,
          workspaceId: task.workspaceId,
          runId: run.id,
          sessionId: null,
          status: 'failed',
          reason,
        } satisfies SchedulerRunEvent);
        advanceSchedule();
        diagLog(`[SchedulerService] dispatch failed for task ${task.id}: ${reason}`);
        return run;
      }
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  private finishRun(
    runId: string,
    task: ScheduledTask,
    sessionId: string,
    resultEvent: Extract<SseEvent, { type: 'result' }> | null,
    errorReason?: string,
  ): void {
    const resultText = resultEvent?.result ?? null;
    let failed = errorReason !== undefined || (resultEvent?.isError ?? false);
    let reason = errorReason ?? (failed ? (resultText ?? '执行失败') : null);
    // Marker classification only applies on the claude backend, where the Stop
    // hook enforces the marker protocol (injecting continuation until the
    // model writes GOAL_STATUS or the turn cap is hit). The degraded opencode
    // path has no evaluator — the wrapped text is only a prompt convention the
    // model may or may not follow — so there the honest signal is isError.
    const backend = this.store.getLocalSession(sessionId)?.backend;
    if (!failed && resultEvent && backend === 'claude') {
      const text = typeof resultText === 'string' ? resultText : '';
      const blocked = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith(GOAL_BLOCKED_PREFIX));
      if (blocked) {
        failed = true;
        reason = blocked;
      } else if (!text.includes(GOAL_COMPLETE_MARKER)) {
        failed = true;
        reason = FAIL_REASON_INCOMPLETE;
      }
    }
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
      resultText,
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
 * Run instructions go out wrapped in the goal protocol (KTD-3, path B): the
 * instruction plus the completion standard, status-marker contract, and turn
 * cap. On the claude backend the Stop-hook evaluator (goal-stop-hook) drives
 * the loop; on other backends the wrapped text alone is the degraded mode.
 */
export function wrapInstructionForRun(task: ScheduledTask): string {
  return buildGoalPrompt(task.instruction);
}

export const schedulerService = new SchedulerService();
