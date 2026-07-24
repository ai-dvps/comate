import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../storage/sqlite-store.js';
import { scheduledTasksService } from '../services/scheduled-tasks-service.js';
import router from './scheduled-tasks.js';

type Handler = (req: unknown, res: unknown) => Promise<void>;

function extractHandlers(): Record<string, Record<string, Handler>> {
  const layers = (router as unknown as {
    stack: Array<{
      route?: {
        methods: Record<string, boolean>;
        path: string;
        stack: Array<{ handle: Handler }>;
      };
    }>;
  }).stack;
  const handlers: Record<string, Record<string, Handler>> = {};
  for (const layer of layers) {
    if (!layer.route) continue;
    const path = layer.route.path;
    if (!handlers[path]) handlers[path] = {};
    for (const method of Object.keys(layer.route.methods)) {
      handlers[path][method] = layer.route.stack[0].handle;
    }
  }
  return handlers;
}

const handlers = extractHandlers();

function createMockRes(): {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): unknown;
  json(body: unknown): void;
} {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
    },
  };
  return res;
}

async function call(method: string, path: string, req: { params?: unknown; body?: unknown }): Promise<{ statusCode: number; jsonBody: unknown }> {
  const handler = handlers[path]?.[method];
  assert.ok(handler, `no handler for ${method} ${path}`);
  const res = createMockRes();
  await handler({ params: req.params ?? {}, body: req.body ?? {} }, res);
  return { statusCode: res.statusCode, jsonBody: res.jsonBody };
}

let workspaceId: string;

beforeEach(async () => {
  store.resetData();
  const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-routes' });
  workspaceId = ws.id;
});

const futureOnce = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('POST / (create)', () => {
  it('creates an active task with confirm snapshot and computed nextFireAt (KTD-5)', async () => {
    const res = await call('post', '/', {
      params: { id: workspaceId },
      body: { name: 'deploy', instruction: 'deploy the app', scheduleType: 'once', scheduleTime: futureOnce() },
    });
    assert.equal(res.statusCode, 201);
    const task = (res.jsonBody as { task: { status: string; nextFireAt: string | null; confirmedSnapshot: { folderPath: string; approvalMode: string } } }).task;
    assert.equal(task.status, 'active');
    assert.ok(task.nextFireAt);
    assert.equal(task.confirmedSnapshot.folderPath, '/tmp/ws-routes');
    assert.equal(task.confirmedSnapshot.approvalMode, 'auto');
  });

  it('rejects past one-shot time with 400', async () => {
    const res = await call('post', '/', {
      params: { id: workspaceId },
      body: { name: 'past', instruction: 'x', scheduleType: 'once', scheduleTime: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects invalid cron with 400 and missing fields with 400', async () => {
    const bad = await call('post', '/', {
      params: { id: workspaceId },
      body: { name: 'cron', instruction: 'x', scheduleType: 'recurring', cronExpr: '0 25 * * *' },
    });
    assert.equal(bad.statusCode, 400);
    const missing = await call('post', '/', { params: { id: workspaceId }, body: { name: 'x' } });
    assert.equal(missing.statusCode, 400);
  });

  it('rejects unknown workspace with 404', async () => {
    const res = await call('post', '/', {
      params: { id: 'no-such-ws' },
      body: { name: 'x', instruction: 'y', scheduleType: 'once', scheduleTime: futureOnce() },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET / (list)', () => {
  it('global list excludes soft-deleted tasks and carries latestRun', async () => {
    const created = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    scheduledTasksService.createDraft(workspaceId, {
      workspaceId,
      name: 'b',
      instruction: 'y',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    store.createTaskRun({ taskId: created.id, status: 'succeeded', fireAt: '2026-07-24T09:00:00.000Z', instructionSnapshot: 'x' });
    scheduledTasksService.deleteTask(created.id);

    const res = await call('get', '/', { params: {} });
    assert.equal(res.statusCode, 200);
    const tasks = (res.jsonBody as { tasks: { name: string; latestRun: unknown }[] }).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'b');
  });

  it('workspace list returns 404 for unknown workspace', async () => {
    const res = await call('get', '/', { params: { id: 'nope' } });
    assert.equal(res.statusCode, 404);
  });
});

describe('PUT/DELETE /:taskId', () => {
  it('edit recomputes nextFireAt; pause clears it; resume restores it', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    const paused = await call('put', '/:taskId', { params: { id: workspaceId, taskId: task.id }, body: { status: 'paused' } });
    assert.equal((paused.jsonBody as { task: { nextFireAt: string | null } }).task.nextFireAt, null);
    const resumed = await call('put', '/:taskId', { params: { id: workspaceId, taskId: task.id }, body: { status: 'active' } });
    assert.ok((resumed.jsonBody as { task: { nextFireAt: string | null } }).task.nextFireAt);
    const badEdit = await call('put', '/:taskId', { params: { id: workspaceId, taskId: task.id }, body: { cronExpr: 'bad expr' } });
    assert.equal(badEdit.statusCode, 400);
  });

  it('PUT whitelists editable keys: confirmedSnapshot/nextFireAt/workspaceId/deletedAt are dropped', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    const snapshotBefore = store.getScheduledTask(task.id)!.confirmedSnapshot;
    assert.equal(snapshotBefore?.folderPath, '/tmp/ws-routes');
    const res = await call('put', '/:taskId', {
      params: { id: workspaceId, taskId: task.id },
      body: {
        name: 'renamed',
        confirmedSnapshot: { folderPath: '/etc/evil', backend: 'opencode', approvalMode: 'auto' },
        nextFireAt: '2020-01-01T00:00:00.000Z',
        workspaceId: 'no-such-ws',
        deletedAt: '2020-01-01T00:00:00.000Z',
      },
    });
    assert.equal(res.statusCode, 200);
    const after = store.getScheduledTask(task.id)!;
    assert.equal(after.name, 'renamed');
    // Confirm-time snapshot untouched — still the value confirmTask captured
    assert.deepEqual(after.confirmedSnapshot, snapshotBefore);
    // Schedule cursor recomputed by the service, not taken from the body
    assert.ok(after.nextFireAt);
    assert.notEqual(after.nextFireAt, '2020-01-01T00:00:00.000Z');
    assert.equal(after.workspaceId, workspaceId);
    assert.equal(after.deletedAt, null);
  });

  it('soft delete hides the task from list and detail', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    const del = await call('delete', '/:taskId', { params: { id: workspaceId, taskId: task.id } });
    assert.equal(del.statusCode, 200);
    const detail = await call('get', '/:taskId', { params: { id: workspaceId, taskId: task.id } });
    assert.equal(detail.statusCode, 404);
  });
});

describe('confirm and run-now gates', () => {
  it('confirm moves draft to active with snapshot; second confirm returns 409 (R6)', async () => {
    const draft = scheduledTasksService.createDraft(workspaceId, {
      workspaceId,
      name: 'd',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    const confirmed = await call('post', '/:taskId/confirm', { params: { id: workspaceId, taskId: draft.id } });
    assert.equal(confirmed.statusCode, 200);
    assert.equal((confirmed.jsonBody as { task: { status: string } }).task.status, 'active');
    const again = await call('post', '/:taskId/confirm', { params: { id: workspaceId, taskId: draft.id } });
    assert.equal(again.statusCode, 409);
  });

  it('confirming an overdue one-shot draft keeps the past nextFireAt so reconcile marks it missed (deliberate divergence from recomputeNextFire)', async () => {
    const draft = scheduledTasksService.createDraft(workspaceId, {
      workspaceId,
      name: 'late',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    // Time passes while the draft awaits confirmation
    store.updateScheduledTask(draft.id, { scheduleTime: '2020-01-01T00:00:00.000Z' });
    const confirmed = await scheduledTasksService.confirmTask(draft.id);
    assert.equal(confirmed.nextFireAt, '2020-01-01T00:00:00.000Z');
    assert.equal(confirmed.status, 'active');
  });

  it('run-now on a draft is rejected with 409 (service-layer gate)', async () => {
    const draft = scheduledTasksService.createDraft(workspaceId, {
      workspaceId,
      name: 'd',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    const res = await call('post', '/:taskId/run-now', { params: { id: workspaceId, taskId: draft.id } });
    assert.equal(res.statusCode, 409);
  });

  it('run-now on a task with a running run is rejected with 409', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    store.createTaskRun({ taskId: task.id, status: 'running', fireAt: '2026-07-24T09:00:00.000Z', instructionSnapshot: 'x' });
    const res = await call('post', '/:taskId/run-now', { params: { id: workspaceId, taskId: task.id } });
    assert.equal(res.statusCode, 409);
  });
});

describe('GET /:taskId/runs', () => {
  it('returns the run history newest-first', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    store.createTaskRun({ taskId: task.id, status: 'succeeded', fireAt: '2026-07-23T09:00:00.000Z', instructionSnapshot: 'x' });
    store.createTaskRun({ taskId: task.id, status: 'missed', fireAt: '2026-07-24T09:00:00.000Z', reason: 'missed', instructionSnapshot: 'x' });
    const res = await call('get', '/:taskId/runs', { params: { id: workspaceId, taskId: task.id } });
    assert.equal(res.statusCode, 200);
    const runs = (res.jsonBody as { runs: { status: string }[] }).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'missed');
  });
});

describe('workspace scoping (cross-workspace 404)', () => {
  it('GET/PUT/DELETE/confirm/run-now/runs against another workspace\'s task all return 404 and change nothing', async () => {
    const other = await store.create({ name: 'WS2', folderPath: '/tmp/ws-other' });
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    const draft = scheduledTasksService.createDraft(workspaceId, {
      workspaceId,
      name: 'd',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: '0 9 * * *',
    });

    const get = await call('get', '/:taskId', { params: { id: other.id, taskId: task.id } });
    assert.equal(get.statusCode, 404);

    const put = await call('put', '/:taskId', { params: { id: other.id, taskId: task.id }, body: { name: 'hijack' } });
    assert.equal(put.statusCode, 404);

    const del = await call('delete', '/:taskId', { params: { id: other.id, taskId: task.id } });
    assert.equal(del.statusCode, 404);

    const confirm = await call('post', '/:taskId/confirm', { params: { id: other.id, taskId: draft.id } });
    assert.equal(confirm.statusCode, 404);

    const runNow = await call('post', '/:taskId/run-now', { params: { id: other.id, taskId: task.id } });
    assert.equal(runNow.statusCode, 404);

    const runs = await call('get', '/:taskId/runs', { params: { id: other.id, taskId: task.id } });
    assert.equal(runs.statusCode, 404);

    // Nothing was mutated: task still active with its original name, draft still a draft
    const afterTask = store.getScheduledTask(task.id)!;
    assert.equal(afterTask.name, 'a');
    assert.equal(afterTask.status, 'active');
    assert.equal(afterTask.deletedAt, null);
    assert.equal(store.getScheduledTask(draft.id)!.status, 'draft');
  });

  it('same-workspace access still works; unknown task id 404s in either workspace', async () => {
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: 'a',
      instruction: 'x',
      scheduleType: 'once',
      scheduleTime: futureOnce(),
    });
    const ok = await call('get', '/:taskId', { params: { id: workspaceId, taskId: task.id } });
    assert.equal(ok.statusCode, 200);
    const missing = await call('get', '/:taskId', { params: { id: workspaceId, taskId: 'no-such-task' } });
    assert.equal(missing.statusCode, 404);
  });
});
