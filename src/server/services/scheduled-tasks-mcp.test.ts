import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../storage/sqlite-store.js';
import {
  buildScheduledTaskToolDefinitions,
  resolveScheduledTasksMcpDeps,
  type ScheduledTasksMcpDeps,
} from './scheduled-tasks-mcp.js';
import { schedulerEvents } from './scheduler-service.js';
import { scheduledTasksService } from './scheduled-tasks-service.js';

const HUMAN_ONLY = ['confirm', 'edit', 'delete'];

function toolsFor(source: string | undefined) {
  const deps: ScheduledTasksMcpDeps = { workspaceId, source };
  return buildScheduledTaskToolDefinitions(deps);
}

async function callTool(source: string | undefined, name: string, args: Record<string, unknown>) {
  const tool = toolsFor(source).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist for source ${source}`);
  return (tool.handler as (a: never) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>)(args as never);
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n');
}

let workspaceId: string;

beforeEach(async () => {
  store.resetData();
  schedulerEvents.removeAllListeners();
  const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-mcp' });
  workspaceId = ws.id;
});

describe('tool surface by session source (KTD-5)', () => {
  it('local GUI sessions get draft + list + pause + resume + run-now; never confirm/edit/delete', () => {
    const names = toolsFor(undefined).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      'create_scheduled_task_draft',
      'list_scheduled_tasks',
      'pause_scheduled_task',
      'resume_scheduled_task',
      'run_scheduled_task_now',
    ]);
    for (const forbidden of HUMAN_ONLY) {
      assert.ok(!names.some((n) => n.includes(forbidden)), `${forbidden} must stay human-only`);
    }
  });

  it('bot sessions (wecom/feishu) get only the draft tool', () => {
    assert.deepEqual(toolsFor('wecom').map((t) => t.name), ['create_scheduled_task_draft']);
    assert.deepEqual(toolsFor('feishu').map((t) => t.name), ['create_scheduled_task_draft']);
  });

  it('resolveScheduledTasksMcpDeps: gui → deps, wecom → deps, scheduled → null, unknown → null', async () => {
    const gui = store.createLocalSession(workspaceId, 'gui-session');
    const wecom = store.createLocalSession(workspaceId, 'bot-session', undefined, undefined, 'wecom');
    const scheduled = store.createLocalSession(workspaceId, 'run-session', 'auto', undefined, 'scheduled');
    assert.deepEqual(await resolveScheduledTasksMcpDeps(gui.id), { workspaceId, source: undefined });
    assert.deepEqual(await resolveScheduledTasksMcpDeps(wecom.id), { workspaceId, source: 'wecom' });
    assert.equal(await resolveScheduledTasksMcpDeps(scheduled.id), null);
    assert.equal(await resolveScheduledTasksMcpDeps('nope'), null);
  });
});

describe('draft tool (R5/R6)', () => {
  it('creates a draft and emits draft-created; nothing becomes active without UI confirm', async () => {
    const events: { taskId: string }[] = [];
    schedulerEvents.on('draft-created', (e) => events.push(e));
    const result = await callTool('wecom', 'create_scheduled_task_draft', {
      name: 'deploy',
      instruction: 'run the deploy script at repo root and report the result',
      scheduleType: 'once',
      scheduleTime: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(result.isError ?? false, false);
    assert.match(textOf(result), /待确认|确认/);
    const tasks = store.listScheduledTasks({ workspaceId });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'draft');
    assert.equal(events.length, 1);
  });

  it('rejects invalid schedules as error text instead of throwing', async () => {
    const result = await callTool(undefined, 'create_scheduled_task_draft', {
      name: 'bad',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: 'not a cron',
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /调度规则无效/);
  });
});

describe('list/pause/resume/run-now tools', () => {
  it('list shows tasks with status; pause/resume flip status; run-now rejects drafts', async () => {
    const draft = await callTool(undefined, 'create_scheduled_task_draft', {
      name: 'nightly',
      instruction: 'do the nightly thing',
      scheduleType: 'recurring',
      cronExpr: '0 3 * * *',
    });
    assert.equal(draft.isError ?? false, false);
    const taskId = store.listScheduledTasks({ workspaceId })[0].id;

    const listed = await callTool(undefined, 'list_scheduled_tasks', {});
    assert.match(textOf(listed), /nightly/);
    assert.match(textOf(listed), /draft/);

    // Drafts cannot be paused/resumed directly — the confirm gate comes first (KTD-5)
    const pausedDraft = await callTool(undefined, 'pause_scheduled_task', { taskId });
    assert.equal(pausedDraft.isError, true);

    await scheduledTasksService.confirmTask(taskId);

    const paused = await callTool(undefined, 'pause_scheduled_task', { taskId });
    assert.match(textOf(paused), /已暂停/);
    assert.equal(store.getScheduledTask(taskId)!.status, 'paused');

    const resumed = await callTool(undefined, 'resume_scheduled_task', { taskId });
    assert.match(textOf(resumed), /已恢复/);
    assert.equal(store.getScheduledTask(taskId)!.status, 'active');

    const runDraft = await callTool(undefined, 'run_scheduled_task_now', { taskId: store.createScheduledTask({ workspaceId, name: 'd2', instruction: 'x', scheduleType: 'recurring', cronExpr: '0 9 * * *' }).id });
    assert.equal(runDraft.isError, true);
    assert.match(textOf(runDraft), /尚未确认/);
  });
});
