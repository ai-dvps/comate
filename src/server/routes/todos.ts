import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
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
