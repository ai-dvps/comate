import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createIsolatedStore } from '../test-utils/test-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { CreateScheduledTaskInput, CreateTaskRunInput } from '../models/scheduled-task.js';

describe('SqliteStore scheduled tasks', { concurrency: false }, () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = createIsolatedStore();
  });

  function createTaskInput(overrides: Partial<CreateScheduledTaskInput> = {}): CreateScheduledTaskInput {
    return {
      workspaceId: 'ws-1',
      name: 'Nightly report',
      instruction: 'Summarize the repo activity',
      scheduleType: 'recurring',
      scheduleTime: null,
      cronExpr: '0 9 * * *',
      wecomRecipient: null,
      ...overrides,
    };
  }

  function createRunInput(taskId: string, overrides: Partial<CreateTaskRunInput> = {}): CreateTaskRunInput {
    return {
      taskId,
      status: 'running',
      fireAt: new Date().toISOString(),
      sessionId: null,
      startedAt: null,
      endedAt: null,
      reason: null,
      instructionSnapshot: 'Summarize the repo activity',
      ...overrides,
    };
  }

  // ---------- Happy path ----------

  it('createScheduledTask creates an active task with defaults', () => {
    const task = store.createScheduledTask(createTaskInput());
    assert.ok(task.id);
    assert.strictEqual(task.workspaceId, 'ws-1');
    assert.strictEqual(task.name, 'Nightly report');
    assert.strictEqual(task.instruction, 'Summarize the repo activity');
    assert.strictEqual(task.scheduleType, 'recurring');
    assert.strictEqual(task.cronExpr, '0 9 * * *');
    assert.strictEqual(task.scheduleTime, null);
    assert.strictEqual(task.status, 'active');
    assert.strictEqual(task.deletedAt, null);
    assert.strictEqual(task.confirmedSnapshot, null);
    assert.strictEqual(task.nextFireAt, null);
    // Notification defaults: desktop + in-app on, WeCom off (KTD-7).
    assert.strictEqual(task.notifyDesktop, true);
    assert.strictEqual(task.notifyInApp, true);
    assert.strictEqual(task.notifyWecom, false);
    assert.strictEqual(task.wecomRecipient, null);
    assert.ok(task.createdAt);
    assert.ok(task.updatedAt);
  });

  it('getScheduledTask returns the task by id and null for unknown ids', () => {
    const task = store.createScheduledTask(createTaskInput());
    const found = store.getScheduledTask(task.id);
    assert.ok(found);
    assert.strictEqual(found.id, task.id);
    assert.strictEqual(store.getScheduledTask('no-such-task'), null);
  });

  it('listScheduledTasks filters by workspace', () => {
    store.createScheduledTask(createTaskInput({ workspaceId: 'ws-1', name: 'A' }));
    store.createScheduledTask(createTaskInput({ workspaceId: 'ws-1', name: 'B' }));
    store.createScheduledTask(createTaskInput({ workspaceId: 'ws-2', name: 'C' }));

    const ws1 = store.listScheduledTasks({ workspaceId: 'ws-1' });
    assert.strictEqual(ws1.length, 2);
    assert.deepStrictEqual(ws1.map((t) => t.name), ['A', 'B']);

    const all = store.listScheduledTasks();
    assert.strictEqual(all.length, 3);
  });

  it('updateScheduledTask walks the status lifecycle active→paused→active→disabled', () => {
    const task = store.createScheduledTask(createTaskInput());
    assert.strictEqual(task.status, 'active');

    // snapshot + next fire written by the service layer at creation.
    const confirmed = store.updateScheduledTask(task.id, {
      status: 'active',
      confirmedSnapshot: { folderPath: '/repo', backend: 'claude', approvalMode: 'auto' },
      nextFireAt: '2026-07-25T09:00:00.000Z',
    });
    assert.ok(confirmed);
    assert.strictEqual(confirmed.status, 'active');
    assert.deepStrictEqual(confirmed.confirmedSnapshot, {
      folderPath: '/repo',
      backend: 'claude',
      approvalMode: 'auto',
    });
    assert.strictEqual(confirmed.nextFireAt, '2026-07-25T09:00:00.000Z');
    assert.ok(confirmed.updatedAt >= task.updatedAt);

    // active ↔ paused
    assert.strictEqual(store.updateScheduledTask(task.id, { status: 'paused' })?.status, 'paused');
    assert.strictEqual(store.updateScheduledTask(task.id, { status: 'active' })?.status, 'active');

    // once-fired → disabled; scheduler clears the next fire cursor.
    const disabled = store.updateScheduledTask(task.id, { status: 'disabled', nextFireAt: null });
    assert.strictEqual(disabled?.status, 'disabled');
    assert.strictEqual(disabled?.nextFireAt, null);
  });

  it('updateScheduledTask applies partial field updates only', () => {
    const task = store.createScheduledTask(createTaskInput({ name: 'Before', instruction: 'old' }));
    const updated = store.updateScheduledTask(task.id, { name: 'After' });
    assert.strictEqual(updated?.name, 'After');
    assert.strictEqual(updated?.instruction, 'old');
    assert.strictEqual(updated?.cronExpr, '0 9 * * *');
  });

  it('softDeleteScheduledTask hides the task from default lists but keeps it fetchable', () => {
    const task = store.createScheduledTask(createTaskInput());
    const deleted = store.softDeleteScheduledTask(task.id);
    assert.ok(deleted);
    assert.ok(deleted.deletedAt);

    assert.strictEqual(store.listScheduledTasks({ workspaceId: 'ws-1' }).length, 0);
    const withDeleted = store.listScheduledTasks({ workspaceId: 'ws-1', includeDeleted: true });
    assert.strictEqual(withDeleted.length, 1);
    assert.ok(withDeleted[0].deletedAt);

    // KTD-2: the retained definition stays traceable for run history.
    const fetched = store.getScheduledTask(task.id);
    assert.ok(fetched);
    assert.ok(fetched.deletedAt);
  });

  it('softDeleteScheduledTask returns null for unknown ids and is idempotent', () => {
    assert.strictEqual(store.softDeleteScheduledTask('no-such-task'), null);
    const task = store.createScheduledTask(createTaskInput());
    const first = store.softDeleteScheduledTask(task.id);
    const second = store.softDeleteScheduledTask(task.id);
    assert.ok(first?.deletedAt);
    assert.ok(second?.deletedAt);
  });

  // ---------- Edge shapes ----------

  it('stores a once task with scheduleTime and null cronExpr', () => {
    const task = store.createScheduledTask(createTaskInput({
      scheduleType: 'once',
      scheduleTime: '2026-07-25T09:00:00.000Z',
      cronExpr: null,
    }));
    assert.strictEqual(task.scheduleType, 'once');
    assert.strictEqual(task.scheduleTime, '2026-07-25T09:00:00.000Z');
    assert.strictEqual(task.cronExpr, null);

    const found = store.getScheduledTask(task.id);
    assert.strictEqual(found?.scheduleTime, '2026-07-25T09:00:00.000Z');
    assert.strictEqual(found?.cronExpr, null);
  });

  it('persists notify flag overrides and wecom recipient', () => {
    const task = store.createScheduledTask(createTaskInput({
      notifyDesktop: false,
      notifyInApp: false,
      notifyWecom: true,
      wecomRecipient: 'plain-user-1',
    }));
    assert.strictEqual(task.notifyDesktop, false);
    assert.strictEqual(task.notifyInApp, false);
    assert.strictEqual(task.notifyWecom, true);
    assert.strictEqual(task.wecomRecipient, 'plain-user-1');

    const found = store.getScheduledTask(task.id);
    assert.strictEqual(found?.notifyWecom, true);
    assert.strictEqual(found?.wecomRecipient, 'plain-user-1');
  });

  it('updateScheduledTask returns null for unknown ids and no-ops on empty input', () => {
    assert.strictEqual(store.updateScheduledTask('no-such-task', { name: 'X' }), null);
    const task = store.createScheduledTask(createTaskInput());
    const same = store.updateScheduledTask(task.id, {});
    assert.strictEqual(same?.name, task.name);
  });

  it('schema creation is idempotent across re-open of the same database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-task-store-test-'));
    const dbPath = join(dir, 'data.db');
    const first = new SqliteStore(dbPath);
    const task = first.createScheduledTask(createTaskInput());

    // Second initialize over the same file must not throw and must see the row.
    const second = new SqliteStore(dbPath);
    const found = second.getScheduledTask(task.id);
    assert.ok(found);
    assert.strictEqual(found.name, 'Nightly report');
  });

  it('deleting a workspace cascades to its scheduled tasks and runs', async () => {
    const ws = await store.create({ name: 'Cascade WS', folderPath: '/tmp/cascade-ws' });
    const task = store.createScheduledTask(createTaskInput({ workspaceId: ws.id }));
    store.createTaskRun(createRunInput(task.id));

    await store.delete(ws.id);

    assert.strictEqual(store.getScheduledTask(task.id), null);
    assert.strictEqual(store.listTaskRuns(task.id).length, 0);
  });

  // ---------- Task runs ----------

  it('createTaskRun writes a run and listTaskRuns returns newest first', () => {
    const task = store.createScheduledTask(createTaskInput());
    const first = store.createTaskRun(createRunInput(task.id, { status: 'succeeded', fireAt: '2026-07-20T09:00:00.000Z' }));
    const second = store.createTaskRun(createRunInput(task.id, { status: 'failed', fireAt: '2026-07-21T09:00:00.000Z' }));
    assert.ok(first.id);
    assert.strictEqual(first.taskId, task.id);
    assert.strictEqual(first.reason, null);
    assert.ok(first.createdAt);

    const other = store.createScheduledTask(createTaskInput({ workspaceId: 'ws-2' }));
    store.createTaskRun(createRunInput(other.id));

    const runs = store.listTaskRuns(task.id);
    assert.strictEqual(runs.length, 2);
    assert.deepStrictEqual(runs.map((r) => r.id), [second.id, first.id]);
  });

  it('updateTaskRun transitions running→succeeded with timing fields', () => {
    const task = store.createScheduledTask(createTaskInput());
    const run = store.createTaskRun(createRunInput(task.id, {
      status: 'running',
      startedAt: '2026-07-21T09:00:00.000Z',
    }));
    assert.strictEqual(run.status, 'running');
    assert.strictEqual(run.endedAt, null);

    const done = store.updateTaskRun(run.id, {
      status: 'succeeded',
      sessionId: 'session-1',
      endedAt: '2026-07-21T09:02:00.000Z',
    });
    assert.strictEqual(done?.status, 'succeeded');
    assert.strictEqual(done?.sessionId, 'session-1');
    assert.strictEqual(done?.endedAt, '2026-07-21T09:02:00.000Z');
    // instruction_snapshot is immutable once written (KTD-10).
    assert.strictEqual(done?.instructionSnapshot, 'Summarize the repo activity');

    assert.strictEqual(store.updateTaskRun('no-such-run', { status: 'failed' }), null);
  });

  it('records missed and skipped runs with reasons and no session', () => {
    const task = store.createScheduledTask(createTaskInput());
    const missed = store.createTaskRun(createRunInput(task.id, {
      status: 'missed',
      reason: 'app not running at fire time',
    }));
    assert.strictEqual(missed.status, 'missed');
    assert.strictEqual(missed.sessionId, null);
    assert.strictEqual(missed.reason, 'app not running at fire time');

    const skipped = store.createTaskRun(createRunInput(task.id, {
      status: 'skipped',
      reason: 'previous run still in flight',
    }));
    assert.strictEqual(skipped.status, 'skipped');

    const runs = store.listTaskRuns(task.id);
    assert.deepStrictEqual(runs.map((r) => r.status), ['skipped', 'missed']);
  });

  it('runs remain queryable after the task is soft-deleted (KTD-2)', () => {
    const task = store.createScheduledTask(createTaskInput());
    const run = store.createTaskRun(createRunInput(task.id, { status: 'succeeded' }));

    store.softDeleteScheduledTask(task.id);

    const runs = store.listTaskRuns(task.id);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].id, run.id);
    assert.strictEqual(runs[0].status, 'succeeded');
  });

  it('latestRunsPerTask returns only the newest run per task', () => {
    const taskA = store.createScheduledTask(createTaskInput({ workspaceId: 'ws-1' }));
    const taskB = store.createScheduledTask(createTaskInput({ workspaceId: 'ws-2' }));
    store.createTaskRun(createRunInput(taskA.id, { status: 'succeeded', fireAt: '2026-07-20T09:00:00.000Z' }));
    const latestA = store.createTaskRun(createRunInput(taskA.id, { status: 'failed', fireAt: '2026-07-21T09:00:00.000Z' }));
    const latestB = store.createTaskRun(createRunInput(taskB.id, { status: 'running', fireAt: '2026-07-21T10:00:00.000Z' }));

    const latest = store.latestRunsPerTask();
    assert.strictEqual(latest.length, 2);
    const byTask = new Map(latest.map((r) => [r.taskId, r]));
    assert.strictEqual(byTask.get(taskA.id)?.id, latestA.id);
    assert.strictEqual(byTask.get(taskA.id)?.status, 'failed');
    assert.strictEqual(byTask.get(taskB.id)?.id, latestB.id);
  });

  it('latestRunsPerTask returns an empty list when no runs exist', () => {
    store.createScheduledTask(createTaskInput());
    assert.deepStrictEqual(store.latestRunsPerTask(), []);
  });
});
