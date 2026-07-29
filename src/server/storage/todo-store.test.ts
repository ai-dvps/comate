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

describe('todo content field (U1)', () => {
  let store: Store;

  beforeEach(() => {
    store = createIsolatedStore();
  });

  it('creates a todo with content and round-trips it through getTodoById', () => {
    const todo = store.createTodo(null, { text: 'title', content: '## detail body' });
    assert.strictEqual(todo.content, '## detail body');
    const fetched = store.getTodoById(todo.id);
    assert.ok(fetched);
    assert.strictEqual(fetched!.content, '## detail body');
    // title is unaffected
    assert.strictEqual(fetched!.text, 'title');
  });

  it('creates a todo without content and reads content back as null', () => {
    const todo = store.createTodo(null, { text: 'no body' });
    assert.strictEqual(todo.content, null);
    const fetched = store.getTodoById(todo.id);
    assert.ok(fetched);
    assert.strictEqual(fetched!.content, null);
  });

  it('updateTodo sets and clears content', () => {
    const todo = store.createTodo(null, { text: 't' });
    assert.strictEqual(todo.content, null);

    const set = store.updateTodo(todo.id, { content: 'first body' });
    assert.ok(set);
    assert.strictEqual(set!.content, 'first body');
    assert.strictEqual(store.getTodoById(todo.id)!.content, 'first body');

    const cleared = store.updateTodo(todo.id, { content: null });
    assert.ok(cleared);
    assert.strictEqual(cleared!.content, null);
    assert.strictEqual(store.getTodoById(todo.id)!.content, null);
  });

  it('updateTodo leaves content untouched when content is absent from the patch', () => {
    const todo = store.createTodo(null, { text: 't', content: 'keep me' });
    // A patch that does not mention content must not null it out.
    const updated = store.updateTodo(todo.id, { status: 'done' });
    assert.ok(updated);
    assert.strictEqual(updated!.status, 'done');
    assert.strictEqual(updated!.content, 'keep me');
  });

  it('content at the 50000-char cap round-trips through the store', () => {
    const big = 'a'.repeat(50000);
    const todo = store.createTodo(null, { text: 'cap', content: big });
    assert.strictEqual(todo.content, big);
    assert.strictEqual(store.getTodoById(todo.id)!.content, big);
  });
});
