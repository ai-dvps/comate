import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../storage/sqlite-store.js';
import type { TodoRun } from '../models/todo.js';
import {
  buildScheduledTaskToolDefinitions,
  resolveScheduledTasksMcpDeps,
  type ScheduledTasksMcpDeps,
} from './scheduled-tasks-mcp.js';
import { todoExecutionService } from './todo-execution-service.js';

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

/** Scheduled Todos for the current test workspace (the unified task store). */
function scheduledTodos(): ReturnType<typeof store.getAllTodos> {
  return store.getAllTodos({ workspaceId }).filter((t) => t.executionType === 'once' || t.executionType === 'recurring');
}

let workspaceId: string;

beforeEach(async () => {
  store.resetData();
  const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-mcp' });
  workspaceId = ws.id;
});

describe('tool surface by session source (KTD-5)', () => {
  it('local GUI sessions get create + list + pause + resume + run-now; edit/delete stay human-only', () => {
    const names = toolsFor(undefined).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      'create_scheduled_task',
      'list_scheduled_tasks',
      'pause_scheduled_task',
      'resume_scheduled_task',
      'run_scheduled_task_now',
    ]);
    for (const forbidden of HUMAN_ONLY) {
      assert.ok(!names.some((n) => n.includes(forbidden)), `${forbidden} must stay human-only`);
    }
  });

  it('bot sessions (wecom/feishu) get create + list only', () => {
    assert.deepEqual(toolsFor('wecom').map((t) => t.name).sort(), ['create_scheduled_task', 'list_scheduled_tasks']);
    assert.deepEqual(toolsFor('feishu').map((t) => t.name).sort(), ['create_scheduled_task', 'list_scheduled_tasks']);
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

describe('create tool', () => {
  it('creates an active scheduled Todo with a computed next fire time', async () => {
    const scheduleTime = new Date(Date.now() + 3600_000).toISOString();
    const result = await callTool('wecom', 'create_scheduled_task', {
      name: 'deploy',
      instruction: 'run the deploy script at repo root and report the result',
      scheduleType: 'once',
      scheduleTime,
    });
    assert.equal(result.isError ?? false, false);
    assert.match(textOf(result), /生效/);
    const todos = scheduledTodos();
    assert.equal(todos.length, 1);
    assert.equal(todos[0].text, 'deploy');
    assert.equal(todos[0].executionStatus, 'active');
    assert.equal(todos[0].nextFireAt, scheduleTime);
  });

  it('rejects invalid schedules as error text instead of throwing, leaving nothing behind', async () => {
    const result = await callTool(undefined, 'create_scheduled_task', {
      name: 'bad',
      instruction: 'x',
      scheduleType: 'recurring',
      cronExpr: 'not a cron',
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /创建任务失败/);
    // Validation runs before the write, so no orphaned Todo row survives.
    assert.equal(scheduledTodos().length, 0);
  });
});

describe('list/pause/resume/run-now tools', () => {
  it('list shows tasks with status; pause/resume flip status; run-now fires', async () => {
    const created = await callTool(undefined, 'create_scheduled_task', {
      name: 'nightly',
      instruction: 'do the nightly thing',
      scheduleType: 'recurring',
      cronExpr: '0 3 * * *',
    });
    assert.equal(created.isError ?? false, false);
    const todos = scheduledTodos();
    assert.equal(todos.length, 1);
    const taskId = todos[0].id;

    const listed = await callTool(undefined, 'list_scheduled_tasks', {});
    assert.match(textOf(listed), /nightly/);
    assert.match(textOf(listed), /active/);

    const paused = await callTool(undefined, 'pause_scheduled_task', { taskId });
    assert.match(textOf(paused), /已暂停/);
    assert.equal(store.getTodoById(taskId)!.executionStatus, 'paused');

    const resumed = await callTool(undefined, 'resume_scheduled_task', { taskId });
    assert.match(textOf(resumed), /已恢复/);
    assert.equal(store.getTodoById(taskId)!.executionStatus, 'active');

    // The real execution singleton would start an SDK session; stub it and
    // assert the tool routes the right id and reports the run.
    const originalRunNow = todoExecutionService.runNow.bind(todoExecutionService);
    let seenId: string | undefined;
    todoExecutionService.runNow = async (todoId: string) => {
      seenId = todoId;
      return { id: 'run-1', status: 'running' } as unknown as TodoRun;
    };
    try {
      const runNow = await callTool(undefined, 'run_scheduled_task_now', { taskId });
      assert.equal(runNow.isError ?? false, false);
      assert.equal(seenId, taskId);
      assert.match(textOf(runNow), /run-1/);
    } finally {
      todoExecutionService.runNow = originalRunNow;
    }
  });

  it('pause/resume/run-now against another workspace\'s task fail with error text; the task is untouched', async () => {
    const other = await store.create({ name: 'WS2', folderPath: '/tmp/ws-mcp-other' });
    // The task belongs to `workspaceId`; the tools below are scoped to `other.id`.
    const task = store.createTodo(workspaceId, {
      text: 'victim',
      instruction: 'x',
      executionType: 'recurring',
      cronExpr: '0 9 * * *',
    });
    const otherTools = buildScheduledTaskToolDefinitions({ workspaceId: other.id, source: undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const tool = otherTools.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} should exist`);
      return (tool.handler as (a: never) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>)(args as never);
    };

    const paused = await invoke('pause_scheduled_task', { taskId: task.id });
    assert.equal(paused.isError, true);
    assert.match(textOf(paused), /不存在/);

    const resumed = await invoke('resume_scheduled_task', { taskId: task.id });
    assert.equal(resumed.isError, true);
    assert.match(textOf(resumed), /不存在/);

    const ran = await invoke('run_scheduled_task_now', { taskId: task.id });
    assert.equal(ran.isError, true);
    assert.match(textOf(ran), /不存在/);

    // Untouched: still active in its own workspace
    assert.equal(store.getTodoById(task.id)!.executionStatus, 'active');
  });
});
