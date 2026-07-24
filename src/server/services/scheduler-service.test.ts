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
  type SchedulerRunEvent,
} from './scheduler-service.js';
import type { ScheduledTask } from '../models/scheduled-task.js';
import type { SseEvent } from '../types/message.js';

let store: SqliteStore;
let current: Date;
let pushed: { sessionId: string; message: string; handler?: (id: number, e: SseEvent) => void }[];
let createdSessions: { workspaceId: string; name: string; source?: string; approvalMode?: string }[];
let failNextPush: Error | null;
let autoComplete: boolean;

const fakeChat = {
  async createSession(input: { workspaceId: string; name: string; source?: string; approvalMode?: string }) {
    createdSessions.push(input);
    return { id: `sess-${createdSessions.length}`, workspaceId: input.workspaceId, name: input.name } as never;
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
      handler(0, { type: 'result', subtype: 'success', isError: false, result: 'done' });
    }
  },
};

function service(): SchedulerService {
  return new SchedulerService({ now: () => current, chat: fakeChat, store });
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
  autoComplete = true;
  schedulerEvents.removeAllListeners();
});

describe('tick firing (KTD-1 window semantics)', () => {
  it('fires an in-window active task: session created with auto approval and completed via result handler (AE1 path, KTD-9)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId, { scheduleType: 'once', cronExpr: null, scheduleTime: '2026-07-24T08:59:50' }), '2026-07-24T08:59:50.000Z');
    await service().tickForTest();
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0].source, 'scheduled');
    assert.equal(createdSessions[0].approvalMode, 'auto');
    assert.equal(pushed.length, 1);
    const runs = store.listTaskRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].sessionId, 'sess-1');
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

  it('does not fire future, out-of-window, paused, draft, or disabled tasks', async () => {
    const wsId = await makeWorkspace();
    activate(makeTask(wsId, { name: 'future' }), '2026-07-24T09:01:00.000Z');
    activate(makeTask(wsId, { name: 'stale' }), '2026-07-24T08:59:00.000Z'); // older than 30s window
    const paused = activate(makeTask(wsId, { name: 'paused' }), '2026-07-24T08:59:50.000Z');
    store.updateScheduledTask(paused.id, { status: 'paused' });
    makeTask(wsId, { name: 'draft' }); // stays draft
    await service().tickForTest();
    assert.equal(createdSessions.length, 0);
  });

  it('overlap: latest run still running → skipped record with reason, no new session (AE3)', async () => {
    const wsId = await makeWorkspace();
    const task = activate(makeTask(wsId), '2026-07-24T08:59:50.000Z');
    store.createTaskRun({ taskId: task.id, status: 'running', fireAt: '2026-07-24T08:00:00.000Z', startedAt: '2026-07-24T08:00:00.000Z', instructionSnapshot: 'prev' });
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
});

describe('runNow', () => {
  it('rejects draft, disabled, and overlapping tasks; allows paused', async () => {
    const wsId = await makeWorkspace();
    const draft = makeTask(wsId);
    await assert.rejects(() => service().runNow(draft.id), (e: SchedulerError) => e.code === 'CONFLICT');

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
    assert.equal(events[0][1].sessionId, 'sess-1');
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
