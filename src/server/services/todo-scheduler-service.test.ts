import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedStore } from '../test-utils/test-store.js';
import { TodoSchedulerService } from './todo-scheduler-service.js';

describe('TodoSchedulerService night-idle queue', () => {
  it('leaves a workspace-less legacy item active instead of silently consuming it', async () => {
    const store = createIsolatedStore();
    const todo = store.createTodo(null, {
      text: 'needs a workspace',
      executionType: 'idle',
      executionStatus: 'active',
    });
    let dispatches = 0;
    const execution = {
      runNow: async () => {
        dispatches += 1;
        throw new Error('workspaceId is required before this Todo can run');
      },
    };
    const scheduler = new TodoSchedulerService({
      store,
      execution,
      now: () => new Date(2026, 7, 12, 1, 0, 0),
      hasExecutingSession: () => false,
    });

    await scheduler.tickForTest();

    assert.strictEqual(dispatches, 0);
    assert.strictEqual(store.getTodoById(todo.id)?.executionStatus, 'active');
    assert.strictEqual(store.listTodoRuns(todo.id).length, 0);
    store.close();
  });

  it('dispatches and disables a workspace-backed night-idle item', async () => {
    const store = createIsolatedStore();
    const todo = store.createTodo('workspace-1', {
      text: 'ready to run',
      executionType: 'idle',
      executionStatus: 'active',
    });
    const dispatched: string[] = [];
    const scheduler = new TodoSchedulerService({
      store,
      execution: {
        runNow: async (todoId) => {
          dispatched.push(todoId);
          throw new Error('stop after proving dispatch');
        },
      },
      now: () => new Date(2026, 7, 12, 1, 0, 0),
      hasExecutingSession: () => false,
    });

    await scheduler.tickForTest();

    assert.deepStrictEqual(dispatched, [todo.id]);
    assert.strictEqual(store.getTodoById(todo.id)?.executionStatus, 'disabled');
    store.close();
  });
});
