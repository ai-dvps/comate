import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedStore } from '../test-utils/test-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import {
  SchedulerService,
  SchedulerError,
  schedulerEvents,
  wrapInstructionForRun,
  SKIP_REASON_PREVIOUS_RUNNING,
  MISS_REASON_APP_NOT_RUNNING,
  FAIL_REASON_PROCESS_RESTART,
  FAIL_REASON_WORKSPACE_DRIFT,
  FAIL_REASON_WATCHDOG,
  FAIL_REASON_INCOMPLETE,
  type SchedulerRunEvent,
} from './scheduler-service.js';
import type { ScheduledTask } from '../models/scheduled-task.js';
import type { SseEvent } from '../types/message.js';

let store: SqliteStore;
let current: Date;
let pushed: { sessionId: string; message: string; handler?: (id: number, e: SseEvent) => void }[];
let createdSessions: { workspaceId: string; name: string; source?: string; approvalMode?: string; backend?: string }[];
let failNextPush: Error | null;
let failNextCreate: Error | null;
let autoComplete: boolean;

let fakeBackend: string;
let lastSessionId: string;

const fakeChat = {
  async createSession(input: { workspaceId: string; name: string; source?: string; approvalMode?: string; backend?: string }) {
    if (failNextCreate) {
      const err = failNextCreate;
      failNextCreate = null;
      throw err;
    }
    createdSessions.push(input);
    // Mirror production: the backend lock is written at the first message.
    const session = store.createLocalSession(input.workspaceId, input.name, 'auto', undefined, input.source as never);
    store.updateSessionBackend(session.id, input.backend ?? fakeBackend);
    store.updateSessionBackendSessionId(session.id, `sdk-${session.id}`);
    lastSessionId = session.id;
    return session as never;
  },
  async pushMessage(
    sessionId: string,
    _workspaceId: string,
    message: string,
    _isBot?: boolean,
    handler?: (id: number, e: SseEvent) => void,
  ) {
    if (failNextPush) {
      const err = failNextPush;
      failNextPush = null;
      throw err;
    }
    pushed.push({ sessionId, message, handler });
    if (autoComplete && handler) {
      handler(0, { type: 'result', subtype: 'success', isError: false, result: 'done\nGOAL_STATUS: COMPLETE' });
    }
  },
};

function service(): SchedulerService {
  return new SchedulerService({ now: () => current, chat: fakeChat, store, resolveBackend: async () => 'claude' });
}

async function makeWorkspace(folderPath = '/tmp/ws-a'): Promise<string> {
  const ws = await store.create({ name: 'WS A', folderPath });
  return ws.id;
}

function makeTask(workspaceId: string, overrides: Partial<Parameters<typeof store.createScheduledTask>[0]> = {}): ScheduledTask {
  return store.createScheduledTask({
    workspaceId,
    name: 'daily-check',
    instruction: 'run the checks',
    scheduleType: 'recurring',
    cronExpr: '0 9 * * *',
    ...overrides,
  });
}

function activate(task: ScheduledTask, nextFireAt: string): ScheduledTask {
  return store.updateScheduledTask(task.id, { status: 'active', nextFireAt })!;
}

beforeEach(() => {
  store = createIsolatedStore();
  current = new Date('2026-07-24T09:00:00.000Z');
  pushed = [];
  createdSessions = [];
  failNextPush = null;
  failNextCreate = null;
  autoComplete = true;
  fakeBackend = 'claude';
  schedulerEvents.removeAllListeners();
});

describe('tick firing (KTD-1 window semantics)', () => {
  it('fires an in-window active task: session created with auto approval and completed via result handler (AE1 path, KTD-9)', async () => {
    const wsId = await makeWorkspace();
    const created = makeTask(wsId, {
      scheduleType: 'once',
      cronExpr: null,
      scheduleTime: '2026-07-24T08:59:50',
    });
    const confirmed = store.updateScheduledTask(created.id, {
      confirmedSnapshot: { folderPath: '/tmp/ws-a', backend: 'claude', approvalMode: 'auto' },
    })!;
    const task = activate(confirmed, '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].source, 'scheduled');
    assert.equal(createdSessions[0].approvalMode, 'auto');
    assert.equal(createdSessions[0].backend, 'claude');
    assert.equal(pushed.length, 1);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].sessionId, lastSessionId);
  });

  it('once task is disabled after firing and never fires again (AE1)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId, { scheduleType: 'once', cronExpr: null, scheduleTime: '2026-07-24T08:59:50' }), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    const after = store.getScheduledTask(task.id)!;
    assert.equal(after.status, 'disabled');
    assert.equal(after.nextFireAt, null);
    await service().tickForTest();
    assert.equal(createdSessions.length, 1);
  });

  it('recurring task gets nextFireAt recomputed to the future after firing', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    const after = store.getScheduledTask(task.id)!;
    assert.ok(after.nextFireAt && new Date(after.nextFireAt) > current);
  });

  it('does not fire future, out-of-window, paused, or disabled tasks', async () => {
    const wsId = await makeWorkspace();
    activate(makeTask(wsId, { name: 'future' }), '2026-07-24T09:01:00.000Z');
    activate(makeTask(wsId, { name: 'stale' }), '2026-07-24T08:59:00.000Z'); // older than 30s window
    const paused = activate(makeTask(wsId, { name: 'paused' }), '2026-07-24T08:59:50.000Z');
    store.updateScheduledTask(paused.id, { status: 'paused' });
    const disabled = activate(makeTask(wsId, { name: 'disabled' }), '2026-07-24T08:59:50.000Z');
    store.updateScheduledTask(disabled.id, { status: 'disabled' });
    await service().tickForTest();
    assert.equal(createdSessions.length, 0);
  });

  it('overlap: latest run still running → skipped record with reason, no new session (AE3)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    // Fresh startedAt: a genuinely live run — older rows are the watchdog's job.
    store.createTaskRun({ taskId: task.id, status: 'running', fireAt: '2026-07-24T08:00:00.000Z', startedAt: '2026-07-24T08:59:40.000Z', instructionSnapshot: 'prev' });
    await service().tickForTest();
    assert.equal(createdSessions.length, 0);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs[0].status, 'skipped');
    assert.equal(runs[0].reason, SKIP_REASON_PREVIOUS_RUNNING);
  });

  it('drift: workspace folderPath differs from confirmed snapshot → failed run, no session (KTD-5)', async () => {
    const wsId = await makeWorkspace('/tmp/ws-moved');
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    store.updateScheduledTask(task.id, {
      confirmedSnapshot: { folderPath: '/tmp/ws-original', backend: 'claude', approvalMode: 'auto' },
    });
    await service().tickForTest();
    assert.equal(createdSessions.length, 0);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].reason, FAIL_REASON_WORKSPACE_DRIFT);
  });

  it('pushMessage rejection marks the run failed with reason', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    failNextPush = new Error('SDK exploded');
    await service().tickForTest();
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs[0].status, 'failed');
    assert.match(runs[0].reason!, /SDK exploded/);
  });

  it('out-of-window overdue occurrence is marked missed and the cursor advanced (R11 系统睡眠)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:55:00.000Z'); // 5 min ago, outside the 30s window
    const events: SchedulerRunEvent[] = [];
    schedulerEvents.on('run-finished', (e) => events.push(e));
    await service().tickForTest();
    assert.equal(createdSessions.length, 0);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'missed');
    assert.equal(runs[0].reason, MISS_REASON_APP_NOT_RUNNING);
    const after = store.getScheduledTask(task.id)!;
    assert.ok(after.nextFireAt && new Date(after.nextFireAt) > current);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'missed');
  });

  it('drift: default backend differs from confirmed snapshot → failed run, no session (KTD-5)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    store.updateScheduledTask(task.id, {
      confirmedSnapshot: { folderPath: '/tmp/ws-a', backend: 'claude', approvalMode: 'auto' },
    });
    const svc = new SchedulerService({ now: () => current, chat: fakeChat, store, resolveBackend: async () => 'opencode' });
    await svc.tickForTest();
    assert.equal(createdSessions.length, 0);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].reason, FAIL_REASON_WORKSPACE_DRIFT);
  });

  it('createSession failure records a failed run, settles the schedule, and nothing escapes tick', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    failNextCreate = new Error('session store full');
    const events: SchedulerRunEvent[] = [];
    schedulerEvents.on('run-finished', (e) => events.push(e));
    await service().tickForTest();
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.match(runs[0].reason!, /session store full/);
    assert.equal(runs[0].sessionId, null);
    const after = store.getScheduledTask(task.id)!;
    assert.ok(after.nextFireAt && new Date(after.nextFireAt) > current);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'failed');
  });

  it('createSession failure on a one-shot task disables it', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId, { scheduleType: 'once', cronExpr: null, scheduleTime: '2026-07-24T08:59:50' }), '2026-07-24T08:59:50.000Z');
    failNextCreate = new Error('boom');
    await service().tickForTest();
    const after = store.getScheduledTask(task.id)!;
    assert.equal(after.status, 'disabled');
    assert.equal(store.listTaskRuns(task.id)[0].status, 'failed');
  });
});

describe('startup reconciliation', () => {
  it('marks one collapsed missed run for an overdue task and recomputes (AE2); idempotent on second pass', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:00:00.000Z');
    await service().reconcile();
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'missed');
    assert.equal(runs[0].reason, MISS_REASON_APP_NOT_RUNNING);
    const after = store.getScheduledTask(task.id)!;
    assert.ok(after.nextFireAt && new Date(after.nextFireAt) > current);
    await service().reconcile();
    assert.equal(store.listTaskRuns(task.id).length, 1);
  });

  it('missed one-shot task is disabled after reconciliation', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId, { scheduleType: 'once', cronExpr: null, scheduleTime: '2026-07-24T08:00:00' }), '2026-07-24T08:00:00.000Z');
    await service().reconcile();
    const after = store.getScheduledTask(task.id)!;
    assert.equal(after.status, 'disabled');
    assert.equal(store.listTaskRuns(task.id)[0].status, 'missed');
  });

  it('stale running runs from a previous process are marked failed', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z');
    store.createTaskRun({ taskId: task.id, status: 'running', fireAt: '2026-07-23T09:00:00.000Z', startedAt: '2026-07-23T09:00:00.000Z', instructionSnapshot: 'x' });
    await service().reconcile();
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'failed');
    assert.equal(run.reason, FAIL_REASON_PROCESS_RESTART);
  });

  it('records the MOST RECENT missed occurrence for a long-overdue recurring task (KTD-9)', async () => {
    const wsId = await makeWorkspace();
    current = new Date('2026-07-24T09:30:00.000Z');
    // Hourly task, stale cursor 5h back: occurrences at 5,6,7,8,9 — one collapsed
    // missed run must point at the last one, not the stale cursor.
    const task = activate(makeTask(wsId, { cronExpr: '0 * * * *' }), '2026-07-24T04:00:00.000Z');
    await service().reconcile();
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'missed');
    const fireAt = new Date(runs[0].fireAt).getTime();
    assert.ok(fireAt > new Date('2026-07-24T04:00:00.000Z').getTime(), 'must not record the stale cursor');
    assert.ok(
      fireAt >= current.getTime() - 60 * 60 * 1000 && fireAt <= current.getTime(),
      `fireAt ${runs[0].fireAt} should be the most recent hour mark`,
    );
    const after = store.getScheduledTask(task.id)!;
    assert.ok(after.nextFireAt && new Date(after.nextFireAt) > current);
  });
});

describe('runNow', () => {
  it('rejects disabled and overlapping tasks; allows paused', async () => {
    const wsId = await makeWorkspace();

    const once = activate(makeTask(wsId, { scheduleType: 'once', cronExpr: null, scheduleTime: '2026-07-24T08:59:50' }), '2026-07-24T08:59:50.000Z');
    await service().runNow(once.id);
    await assert.rejects(() => service().runNow(once.id), (e: SchedulerError) => e.code === 'CONFLICT');

    const running = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z');
    store.createTaskRun({ taskId: running.id, status: 'running', fireAt: '2026-07-24T08:00:00.000Z', startedAt: '2026-07-24T08:00:00.000Z', instructionSnapshot: 'x' });
    await assert.rejects(() => service().runNow(running.id), (e: SchedulerError) => e.code === 'CONFLICT');

    const paused = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z');
    store.updateScheduledTask(paused.id, { status: 'paused' });
    const run = await service().runNow(paused.id);
    // fireTask returns the dispatch-time snapshot; completion is visible on re-read
    assert.equal(store.getTaskRun(run.id)!.status, 'succeeded');
  });

  it('rejects unknown task', async () => {
    await assert.rejects(() => service().runNow('nope'), (e: SchedulerError) => e.code === 'NOT_FOUND');
  });

  it('two concurrent runNow calls produce exactly one session and one run', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z');
    const svc = service();
    const results = await Promise.allSettled([svc.runNow(task.id), svc.runNow(task.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'CONFLICT');
    assert.equal(createdSessions.length, 1);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
  });
});

describe('events and wrapper seam', () => {
  it('emits run-started and run-finished with task/run/session identifiers', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    const events: [string, SchedulerRunEvent][] = [];
    schedulerEvents.on('run-started', (e) => events.push(['started', e]));
    schedulerEvents.on('run-finished', (e) => events.push(['finished', e]));
    await service().tickForTest();
    assert.equal(events.length, 2);
    assert.equal(events[0][1].taskId, task.id);
    assert.equal(events[0][1].sessionId, lastSessionId);
    assert.equal(events[1][1].status, 'succeeded');
  });

  it('wrapInstructionForRun wraps the instruction in the goal protocol (KTD-3 path B)', () => {
    const wsId = 'ws-x';
    const task = makeTask(wsId);
    const wrapped = wrapInstructionForRun(task);
    assert.ok(wrapped.startsWith(task.instruction));
    assert.match(wrapped, /GOAL_STATUS: COMPLETE/);
    assert.match(wrapped, /GOAL_STATUS: BLOCKED/);
    assert.match(wrapped, /20 轮/);
  });
});

describe('run watchdog', () => {
  it('fails a running run whose stream died (startedAt older than the cap) and emits run-finished', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z'); // future — tick will not fire
    store.createTaskRun({
      taskId: task.id,
      sessionId: 'sess-stale',
      status: 'running',
      fireAt: '2026-07-24T08:00:00.000Z',
      startedAt: '2026-07-24T08:00:00.000Z', // 60 min before current — stalled stream
      instructionSnapshot: 'x',
    });
    const events: SchedulerRunEvent[] = [];
    schedulerEvents.on('run-finished', (e) => events.push(e));
    await service().tickForTest();
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'failed');
    assert.equal(run.reason, FAIL_REASON_WATCHDOG);
    assert.ok(run.endedAt);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].reason, FAIL_REASON_WATCHDOG);
    assert.equal(events[0].sessionId, 'sess-stale');
  });

  it('leaves fresh running runs untouched', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-25T09:00:00.000Z');
    store.createTaskRun({
      taskId: task.id,
      status: 'running',
      fireAt: '2026-07-24T08:59:40.000Z',
      startedAt: '2026-07-24T08:59:40.000Z', // 20s old — legitimately in flight
      instructionSnapshot: 'x',
    });
    const events: SchedulerRunEvent[] = [];
    schedulerEvents.on('run-finished', (e) => events.push(e));
    await service().tickForTest();
    assert.equal(store.listTaskRuns(task.id)[0].status, 'running');
    assert.equal(events.length, 0);
  });
});

describe('finishRun goal-marker classification (KTD-3)', () => {
  it('BLOCKED marker in the result → failed with the marker line', async () => {
    autoComplete = false;
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'success', isError: false, result: '部分完成\nGOAL_STATUS: BLOCKED 缺少依赖' });
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'failed');
    assert.match(run.reason!, /GOAL_STATUS: BLOCKED 缺少依赖/);
  });

  it('no completion marker in the result → failed with 未达成完成标准', async () => {
    autoComplete = false;
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'success', isError: false, result: 'done some work but truncated' });
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'failed');
    assert.equal(run.reason, FAIL_REASON_INCOMPLETE);
  });

  it('COMPLETE marker in the result → succeeded', async () => {
    autoComplete = false;
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'success', isError: false, result: 'all done\nGOAL_STATUS: COMPLETE' });
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'succeeded');
    assert.equal(run.reason, null);
  });

  it('opencode session with a plain result (no marker) → succeeded (no evaluator on the degraded path)', async () => {
    autoComplete = false;
    fakeBackend = 'opencode';
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'success', isError: false, result: '文件已创建完成' });
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'succeeded');
    assert.equal(run.reason, null);
  });

  it('opencode session with isError result → failed', async () => {
    autoComplete = false;
    fakeBackend = 'opencode';
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'error', isError: true, result: 'rate limited' });
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'failed');
    assert.equal(run.reason, 'rate limited');
  });

  it('isError still wins over a COMPLETE marker', async () => {
    autoComplete = false;
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    pushed[0].handler!(0, { type: 'result', subtype: 'error', isError: true, result: ' blew up\nGOAL_STATUS: COMPLETE' });
    assert.equal(store.listTaskRuns(task.id)[0].status, 'failed');
  });

  it('a second result event in the reused session does not re-finalize the run', async () => {
    autoComplete = false;
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    const events: SchedulerRunEvent[] = [];
    schedulerEvents.on('run-finished', (e) => events.push(e));
    await service().tickForTest();
    const handler = pushed[0].handler!;
    handler(0, { type: 'result', subtype: 'success', isError: false, result: 'ok\nGOAL_STATUS: COMPLETE' });
    // User follow-up in the same session: its result must not rewrite the run.
    handler(0, { type: 'result', subtype: 'success', isError: false, result: 'GOAL_STATUS: BLOCKED later turn' });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'succeeded');
    const run = store.listTaskRuns(task.id)[0];
    assert.equal(run.status, 'succeeded');
    assert.equal(run.reason, null);
  });
});
