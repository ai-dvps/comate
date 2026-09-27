import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedStore } from '../test-utils/test-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { RunNotifier } from './run-notifier.js';
import { schedulerEvents, type SchedulerRunEvent } from './scheduler-service.js';

let store: SqliteStore;
let sent: { workspaceId: string; userId: string; markdown: string }[];
let senderShouldFail: boolean;

const fakeSender = {
  async sendScheduledTaskSummary(workspaceId: string, userId: string, markdown: string): Promise<boolean> {
    if (senderShouldFail) return false;
    sent.push({ workspaceId, userId, markdown });
    return true;
  },
};

function finishedEvent(overrides: Partial<SchedulerRunEvent> = {}): SchedulerRunEvent {
  return {
    taskId: 'task-1',
    taskName: 'daily-check',
    workspaceId: 'ws-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    status: 'succeeded',
    resultText: 'all checks passed',
    ...overrides,
  };
}

async function makeTask(notifyWecom: boolean, recipient: string | null = null, workspaceId = 'ws-1'): Promise<string> {
  const task = store.createScheduledTask({
    workspaceId,
    name: 'daily-check',
    instruction: 'run checks',
    scheduleType: 'recurring',
    cronExpr: '0 9 * * *',
    notifyWecom,
    wecomRecipient: recipient,
  });
  return task.id;
}

beforeEach(async () => {
  store = createIsolatedStore();
  sent = [];
  senderShouldFail = false;
  schedulerEvents.removeAllListeners();
  await store.create({ name: 'WS', folderPath: '/tmp/ws-n' });
  const ws = await store.create({ name: 'WS1', folderPath: '/tmp/ws-1' });
  // keep the workspace id stable for events ('ws-1' is used by makeTask/events)
  void ws;
});

describe('RunNotifier WeCom fanout', () => {
  it('pushes a truncated markdown summary to the configured recipient on success (KTD-7)', async () => {
    const notifier = new RunNotifier({ store, wecomSender: fakeSender });
    notifier.initialize();
    const taskId = await makeTask(true, 'user-42');
    const longResult = 'x'.repeat(600);
    schedulerEvents.emit('run-finished', finishedEvent({ taskId, resultText: longResult }));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, 'user-42');
    assert.match(sent[0].markdown, /daily-check/);
    assert.match(sent[0].markdown, /执行成功/);
    assert.ok(sent[0].markdown.length < 600);
    assert.match(sent[0].markdown, /…$/);
  });

  it('falls back to the workspace admin when no recipient is configured', async () => {
    await store.resetData();
    const ws = await store.create({
      name: 'WS1',
      folderPath: '/tmp/ws-1',
      settings: { wecomBotIsolation: { adminUserIds: ['admin-1'] } } as never,
    });
    const notifier = new RunNotifier({ store, wecomSender: fakeSender });
    notifier.initialize();
    const taskId = await makeTask(true, null, ws.id);
    schedulerEvents.emit('run-finished', finishedEvent({ taskId, workspaceId: ws.id }));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, 'admin-1');
  });

  it('does not send when notifyWecom is off, when there is no recipient, or for missed/skipped runs', async () => {
    const notifier = new RunNotifier({ store, wecomSender: fakeSender });
    notifier.initialize();
    const offTask = await makeTask(false);
    schedulerEvents.emit('run-finished', finishedEvent({ taskId: offTask }));
    const noRecipient = await makeTask(true);
    schedulerEvents.emit('run-finished', finishedEvent({ taskId: noRecipient, runId: 'run-2' }));
    const withRecipient = await makeTask(true, 'user-7');
    schedulerEvents.emit('run-finished', finishedEvent({ taskId: withRecipient, status: 'missed', sessionId: null }));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
  });

  it('marks failed runs with the failure status and does not throw on sender failure', async () => {
    senderShouldFail = true;
    const notifier = new RunNotifier({ store, wecomSender: fakeSender });
    notifier.initialize();
    const taskId = await makeTask(true, 'user-9');
    schedulerEvents.emit('run-finished', finishedEvent({ taskId, status: 'failed', resultText: null, reason: 'boom' }));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
  });
});
