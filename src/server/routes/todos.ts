import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import { todoSyncService, SyncError } from '../services/todo-sync.js';
import { redactGithubError } from '../services/github-types.js';
import { diagLog } from '../utils/diag-logger.js';
import type { CreateTodoInput, UpdateTodoInput } from '../models/todo.js';

const router = Router({ mergeParams: true });

/** Workspace id comes from the nested mount's `:id` param, or `workspaceId` in the body for the global mount. */
function workspaceIdFromReq(req: { params: unknown; body?: unknown }): string | null {
  const id = (req.params as { id?: string }).id;
  if (id) return id;
  const bodyWs = (req.body as { workspaceId?: string } | undefined)?.workspaceId;
  return bodyWs ?? null;
}

function validateTodoText(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return 'text is required';
  if (text.trim().length > 2000) return 'text must be 2000 characters or less';
  return null;
}

/** Redact any GitHub-derived error before it reaches a logger or response (R13). */
function handleSyncError(res: { status(code: number): unknown; json(body: unknown): void }, err: unknown, fallback: string): void {
  if (err instanceof SyncError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const redacted = redactGithubError(err);
  diagLog('[todos] ' + fallback + ': ' + JSON.stringify(redacted));
  res.status(500).json({ error: fallback });
}

// GET /api/todos (global) or /api/workspaces/:id/todos (workspace-scoped)
router.get('/', async (req, res) => {
  try {
    const id = (req.params as { id?: string }).id;
    const todos = id ? store.getTodosByWorkspace(id) : store.getAllTodos();
    res.json({ todos });
  } catch (error) {
    console.error('Failed to list todos:', error);
    res.status(500).json({ error: 'Failed to list todos' });
  }
});

// POST /api/todos or /api/workspaces/:id/todos
router.post('/', async (req, res) => {
  try {
    const input = req.body as CreateTodoInput;
    const err = validateTodoText(input?.text);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const workspaceId = workspaceIdFromReq(req);
    const todo = store.createTodo(workspaceId, { text: input.text, dueDate: input.dueDate });
    res.status(201).json({ todo });
  } catch (error) {
    console.error('Failed to create todo:', error);
    res.status(500).json({ error: 'Failed to create todo' });
  }
});

// PUT /api/todos/:todoId or /api/workspaces/:id/todos/:todoId
router.put('/:todoId', async (req, res) => {
  try {
    const todoId = req.params.todoId;
    const input = req.body as UpdateTodoInput;

    if (input.text !== undefined && input.text.trim().length === 0) {
      res.status(400).json({ error: 'text cannot be empty' });
      return;
    }
    if (input.text && input.text.trim().length > 2000) {
      res.status(400).json({ error: 'text must be 2000 characters or less' });
      return;
    }

    const todo = store.updateTodo(todoId, input);
    if (!todo) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }
    res.json({ todo });
  } catch (error) {
    console.error('Failed to update todo:', error);
    res.status(500).json({ error: 'Failed to update todo' });
  }
});

// DELETE /api/todos/:todoId or /api/workspaces/:id/todos/:todoId
router.delete('/:todoId', async (req, res) => {
  try {
    const deleted = store.deleteTodo(req.params.todoId);
    if (!deleted) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete todo:', error);
    res.status(500).json({ error: 'Failed to delete todo' });
  }
});

// POST /api/todos/sync — on-demand reconcile (panel-open / manual refresh). F3.
router.post('/sync', async (_req, res) => {
  try {
    const result = await todoSyncService.reconcile();
    res.json({ sync: result });
  } catch (err) {
    handleSyncError(res, err, 'Failed to sync todos');
  }
});

// POST /api/todos/pull — pull a GitHub issue into a local replica (F2).
router.post('/pull', async (req, res) => {
  try {
    const body = req.body as { repo?: string; issueNumber?: number; workspaceId?: string | null } | undefined;
    if (!body?.repo || typeof body.issueNumber !== 'number') {
      res.status(400).json({ error: 'repo and issueNumber are required' });
      return;
    }
    const todo = await todoSyncService.pull(body.repo, body.issueNumber, body.workspaceId ?? null);
    res.status(201).json({ todo });
  } catch (err) {
    handleSyncError(res, err, 'Failed to pull issue');
  }
});

// GET /api/todos/:todoId/comments — merged comment stream (append-only, R10).
router.get('/:todoId/comments', (req, res) => {
  try {
    res.json({ comments: store.listTodoComments(req.params.todoId) });
  } catch (err) {
    handleSyncError(res, err, 'Failed to list comments');
  }
});

// POST /api/todos/:todoId/comments — add a local comment (pushed outward on next sync).
router.post('/:todoId/comments', (req, res) => {
  try {
    const body = req.body as { body?: string; author?: string } | undefined;
    if (!body?.body || body.body.trim().length === 0) {
      res.status(400).json({ error: 'body is required' });
      return;
    }
    const todo = store.getTodoById(req.params.todoId);
    if (!todo) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }
    const comment = store.addLocalTodoComment(req.params.todoId, body.body.trim(), body.author?.trim() || 'you');
    res.status(201).json({ comment });
  } catch (err) {
    handleSyncError(res, err, 'Failed to add comment');
  }
});

// POST /api/todos/:todoId/publish — publish a local todo to a GitHub issue (F1).
router.post('/:todoId/publish', async (req, res) => {
  try {
    const repo = (req.body as { repo?: string } | undefined)?.repo;
    const todo = await todoSyncService.publish(req.params.todoId, repo);
    res.status(201).json({ todo });
  } catch (err) {
    handleSyncError(res, err, 'Failed to publish todo');
  }
});

// POST /api/todos/:todoId/session or /api/workspaces/:id/todos/:todoId/session
router.post('/:todoId/session', async (req, res) => {
  try {
    const todoId = req.params.todoId;
    const todo = store.getTodoById(todoId);
    if (!todo) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }

    const workspaceId = workspaceIdFromReq(req);
    if (todo.workspaceId && workspaceId && todo.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Todo not found in this workspace' });
      return;
    }
    const targetWorkspaceId = workspaceId ?? todo.workspaceId;
    if (!targetWorkspaceId) {
      res.status(400).json({ error: 'workspaceId is required to start a session from a global todo' });
      return;
    }

    if (todo.status !== 'pending') {
      res.status(400).json({ error: 'Todo must be pending to create a session' });
      return;
    }
    if (todo.sessionId) {
      res.status(409).json({ error: 'Todo is already linked to a session' });
      return;
    }

    const session = await chatService.createSession({ workspaceId: targetWorkspaceId, name: todo.text });
    store.linkTodoToSession(todoId, session.id);
    res.status(201).json(session);
  } catch (error) {
    console.error('Failed to create session from todo:', error);
    res.status(500).json({ error: 'Failed to create session from todo' });
  }
});

export default router;
