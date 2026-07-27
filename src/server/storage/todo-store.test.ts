import '../test-utils/test-env.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createIsolatedStore } from '../test-utils/test-store.js';

type Store = ReturnType<typeof createIsolatedStore>;

describe('global todo store (U1)', () => {
  let store: Store;

  beforeEach(() => {
    store = createIsolatedStore();
  });

  it('creates a global todo without a workspace', () => {
    const todo = store.createTodo(null, { text: 'global item' });
    assert.strictEqual(todo.workspaceId, null);
    assert.strictEqual(todo.origin, 'local');
    assert.strictEqual(todo.status, 'pending');
    assert.strictEqual(todo.dueDate, null);
    assert.deepStrictEqual(todo.labels, []);
    assert.strictEqual(todo.originDeleted, false);
    const all = store.getAllTodos();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, todo.id);
  });

  it('filters the global list by workspace soft-link', () => {
    store.createTodo('ws-1', { text: 'in ws-1' });
    store.createTodo('ws-2', { text: 'in ws-2' });
    store.createTodo(null, { text: 'global' });
    assert.strictEqual(store.getAllTodos().length, 3);
    assert.strictEqual(store.getAllTodos({ workspaceId: 'ws-1' }).length, 1);
    assert.strictEqual(store.getAllTodos({ workspaceId: 'ws-1' })[0].text, 'in ws-1');
  });

  it('updates the new global/sync fields', () => {
    const todo = store.createTodo(null, { text: 'x' });
    const updated = store.updateTodo(todo.id, {
      dueDate: '2026-08-01',
      origin: 'github',
      repoFullName: 'myorg/webapp',
      issueNumber: 88,
      remoteSnapshot: JSON.stringify({ title: 't', body: 'b' }),
      labels: ['bug', 'ui'],
      lastSyncedAt: '2026-07-27T00:00:00.000Z',
    });
    assert.ok(updated);
    assert.strictEqual(updated!.dueDate, '2026-08-01');
    assert.strictEqual(updated!.origin, 'github');
    assert.strictEqual(updated!.repoFullName, 'myorg/webapp');
    assert.strictEqual(updated!.issueNumber, 88);
    assert.deepStrictEqual(updated!.labels, ['bug', 'ui']);
    // round-trips through the store
    assert.deepStrictEqual(store.getTodoById(todo.id)!.labels, ['bug', 'ui']);
  });

  it('enforces a unique link per (repo, issue) for pull dedupe', () => {
    const a = store.createTodo(null, { text: 'a' });
    store.updateTodo(a.id, { repoFullName: 'o/r', issueNumber: 42 });
    const b = store.createTodo(null, { text: 'b' });
    assert.throws(() => store.updateTodo(b.id, { repoFullName: 'o/r', issueNumber: 42 }));
  });

  it('deleting a workspace nulls the soft link instead of destroying todos (R15)', async () => {
    const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-r15' });
    store.createTodo(ws.id, { text: 'belonging todo' });
    store.createTodo(null, { text: 'global todo' });

    const deleted = await store.delete(ws.id);
    assert.strictEqual(deleted, true);

    const all = store.getAllTodos();
    assert.strictEqual(all.length, 2, 'both todos survive workspace deletion');
    const belonging = all.find((t) => t.text === 'belonging todo');
    assert.ok(belonging);
    assert.strictEqual(belonging!.workspaceId, null, 'soft link cleared, not destroyed');
  });
});
