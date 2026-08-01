import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import router from './todos.js';

type Handler = (req: unknown, res: unknown) => Promise<void>;

function extractHandlers(): Record<string, Record<string, Handler>> {
  const layers = (router as unknown as {
    stack: Array<{
      route?: { methods: Record<string, boolean>; path: string; stack: Array<{ handle: Handler }> };
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
  send(): void;
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
    send() {
      /* no-op */
    },
  };
  return res;
}

async function call(
  method: string,
  path: string,
  req: { params?: unknown; body?: unknown },
): Promise<{ statusCode: number; jsonBody: unknown }> {
  const handler = handlers[path]?.[method];
  assert.ok(handler, `no handler for ${method} ${path}`);
  const res = createMockRes();
  await handler({ params: req.params ?? {}, body: req.body ?? {} }, res);
  return { statusCode: res.statusCode, jsonBody: res.jsonBody };
}

describe('global todo routes (U2)', () => {
  let workspaceId: string;
  let originalCreateSession: typeof chatService.createSession;

  beforeEach(async () => {
    store.resetData();
    const ws = await store.create({ name: 'WS', folderPath: '/tmp/ws-todos' });
    workspaceId = ws.id;
    // Stub createSession so spawn tests don't spawn a real SDK session.
    originalCreateSession = chatService.createSession;
    chatService.createSession = (async (opts: { workspaceId: string; name: string }) => ({
      id: 'sess-mock',
      workspaceId: opts.workspaceId,
      name: opts.name,
    })) as typeof chatService.createSession;
  });

  afterEach(() => {
    chatService.createSession = originalCreateSession;
  });

  it('GET / returns every todo globally when no workspace id is present', async () => {
    store.createTodo(workspaceId, { text: 'in ws' });
    store.createTodo(null, { text: 'global' });

    const res = await call('get', '/', { params: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { todos: unknown[] }).todos.length, 2);
  });

  it('GET / includes each todo\'s latest execution summary', async () => {
    const todo = store.createTodo(workspaceId, { text: 'scheduled work', executionType: 'recurring' });
    store.createTodoRun({
      todoId: todo.id,
      status: 'failed',
      fireAt: '2026-08-01T00:00:00.000Z',
      instructionSnapshot: 'first attempt',
    });
    store.createTodoRun({
      todoId: todo.id,
      status: 'succeeded',
      fireAt: '2026-08-02T00:00:00.000Z',
      instructionSnapshot: 'retry',
    });

    const res = await call('get', '/', { params: {} });
    assert.strictEqual(res.statusCode, 200);
    const listed = (res.jsonBody as {
      todos: Array<{ id: string; latestRun: { status: string; fireAt: string } | null }>;
    }).todos.find((item) => item.id === todo.id);
    assert.deepStrictEqual(listed?.latestRun, {
      status: 'succeeded',
      fireAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('GET / is workspace-scoped when the nested :id param is present', async () => {
    store.createTodo(workspaceId, { text: 'in ws' });
    store.createTodo(null, { text: 'global' });

    const res = await call('get', '/', { params: { id: workspaceId } });
    assert.strictEqual(res.statusCode, 200);
    const todos = (res.jsonBody as { todos: Array<{ text: string }> }).todos;
    assert.strictEqual(todos.length, 1);
    assert.strictEqual(todos[0].text, 'in ws');
  });

  it('POST / creates a global todo (no workspace) under the global mount', async () => {
    const res = await call('post', '/', { params: {}, body: { text: 'global todo' } });
    assert.strictEqual(res.statusCode, 201);
    const todo = (res.jsonBody as { todo: { workspaceId: string | null; origin: string } }).todo;
    assert.strictEqual(todo.workspaceId, null);
    assert.strictEqual(todo.origin, 'local');
  });

  it('POST / creates a workspace todo under the nested mount', async () => {
    const res = await call('post', '/', { params: { id: workspaceId }, body: { text: 'ws todo' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual((res.jsonBody as { todo: { workspaceId: string } }).todo.workspaceId, workspaceId);
  });

  it('POST / rejects empty text', async () => {
    const res = await call('post', '/', { params: {}, body: { text: '   ' } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('PUT /:todoId updates fields', async () => {
    const created = store.createTodo(null, { text: 'x' });
    const res = await call('put', '/:todoId', { params: { todoId: created.id }, body: { status: 'done', dueDate: '2026-08-01' } });
    assert.strictEqual(res.statusCode, 200);
    const todo = (res.jsonBody as { todo: { status: string; dueDate: string } }).todo;
    assert.strictEqual(todo.status, 'done');
    assert.strictEqual(todo.dueDate, '2026-08-01');
  });

  it('PUT /:todoId 404s for an unknown todo', async () => {
    const res = await call('put', '/:todoId', { params: { todoId: 'nope' }, body: { status: 'done' } });
    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /:todoId removes the todo', async () => {
    const created = store.createTodo(null, { text: 'bye' });
    const res = await call('delete', '/:todoId', { params: { todoId: created.id } });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(store.getTodoById(created.id), null);
  });

  it('POST /:todoId/session 404s for an unknown todo', async () => {
    const res = await call('post', '/:todoId/session', { params: { todoId: 'nope' }, body: {} });
    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /:todoId/session 400s when the todo has no workspace and none is provided', async () => {
    const created = store.createTodo(null, { text: 'orphan' });
    const res = await call('post', '/:todoId/session', { params: { todoId: created.id }, body: {} });
    assert.strictEqual(res.statusCode, 400);
  });

  it('POST /:todoId/session 400s for a non-pending todo', async () => {
    const created = store.createTodo(workspaceId, { text: 'done one' });
    store.updateTodo(created.id, { status: 'done' });
    const res = await call('post', '/:todoId/session', { params: { id: workspaceId, todoId: created.id }, body: {} });
    assert.strictEqual(res.statusCode, 400);
  });

  // U7: preserve "start session from todo" for global todos (R4)
  it('POST /:todoId/session spawns + links when the todo has a workspace', async () => {
    const created = store.createTodo(workspaceId, { text: 'do it' });
    const res = await call('post', '/:todoId/session', { params: { id: workspaceId, todoId: created.id }, body: {} });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual((res.jsonBody as { id: string }).id, 'sess-mock');
    assert.strictEqual(store.getTodoById(created.id)!.sessionId, 'sess-mock');
  });

  it('POST /:todoId/session spawns for a workspace-less todo when workspaceId is in the body', async () => {
    const created = store.createTodo(null, { text: 'global todo' });
    const res = await call('post', '/:todoId/session', { params: { todoId: created.id }, body: { workspaceId } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(store.getTodoById(created.id)!.sessionId, 'sess-mock');
  });

  it('POST /:todoId/session 409s when the todo already has a session', async () => {
    const created = store.createTodo(workspaceId, { text: 'linked' });
    store.linkTodoToSession(created.id, 'existing-session');
    const res = await call('post', '/:todoId/session', { params: { id: workspaceId, todoId: created.id }, body: {} });
    assert.strictEqual(res.statusCode, 409);
  });

  it('POST / accepts content and persists it', async () => {
    const res = await call('post', '/', { params: {}, body: { text: 'with content', content: '## body' } });
    assert.strictEqual(res.statusCode, 201);
    const todo = (res.jsonBody as { todo: { content: string | null; text: string } }).todo;
    assert.strictEqual(todo.content, '## body');
    assert.strictEqual(todo.text, 'with content');
  });

  it('POST / still works when content is absent (optional)', async () => {
    const res = await call('post', '/', { params: {}, body: { text: 'no content' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual((res.jsonBody as { todo: { content: string | null } }).todo.content, null);
  });

  it('POST / rejects content over the 50000-char cap with 400', async () => {
    const res = await call('post', '/', { params: {}, body: { text: 'too long', content: 'x'.repeat(50001) } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('PUT /:todoId updates content', async () => {
    const created = store.createTodo(null, { text: 't' });
    const res = await call('put', '/:todoId', { params: { todoId: created.id }, body: { content: 'new body' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { todo: { content: string | null } }).todo.content, 'new body');
    assert.strictEqual(store.getTodoById(created.id)!.content, 'new body');
  });

  it('PUT /:todoId rejects content over the 50000-char cap with 400', async () => {
    const created = store.createTodo(null, { text: 't' });
    const res = await call('put', '/:todoId', { params: { todoId: created.id }, body: { content: 'y'.repeat(50001) } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('PUT /:todoId accepts null content (clears it)', async () => {
    const created = store.createTodo(null, { text: 't', content: 'body' });
    const res = await call('put', '/:todoId', { params: { todoId: created.id }, body: { content: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.jsonBody as { todo: { content: string | null } }).todo.content, null);
  });

  it('the session name still derives from text, not content', async () => {
    const created = store.createTodo(workspaceId, { text: 'session-name-source', content: 'body should be ignored' });
    const res = await call('post', '/:todoId/session', { params: { id: workspaceId, todoId: created.id }, body: {} });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual((res.jsonBody as { name: string }).name, 'session-name-source');
  });
});
