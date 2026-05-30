import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { chatService } from '../services/chat-service.js';
import type { CreateTodoInput, UpdateTodoInput } from '../models/todo.js';

const router = Router({ mergeParams: true });

// GET /api/workspaces/:id/todos
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const todos = store.getTodosByWorkspace(workspaceId);
    res.json({ todos });
  } catch (error) {
    console.error('Failed to list todos:', error);
    res.status(500).json({ error: 'Failed to list todos' });
  }
});

// POST /api/workspaces/:id/todos
router.post('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const input = req.body as CreateTodoInput;

    if (!input.text || typeof input.text !== 'string' || input.text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (input.text.trim().length > 500) {
      res.status(400).json({ error: 'text must be 500 characters or less' });
      return;
    }

    const todo = store.createTodo(workspaceId, input);
    res.status(201).json({ todo });
  } catch (error) {
    console.error('Failed to create todo:', error);
    res.status(500).json({ error: 'Failed to create todo' });
  }
});

// PUT /api/workspaces/:id/todos/:todoId
router.put('/:todoId', async (req, res) => {
  try {
    const todoId = req.params.todoId;
    const input = req.body as UpdateTodoInput;

    if (input.text !== undefined && input.text.trim().length === 0) {
      res.status(400).json({ error: 'text cannot be empty' });
      return;
    }

    if (input.text && input.text.trim().length > 500) {
      res.status(400).json({ error: 'text must be 500 characters or less' });
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

// DELETE /api/workspaces/:id/todos/:todoId
router.delete('/:todoId', async (req, res) => {
  try {
    const todoId = req.params.todoId;
    const deleted = store.deleteTodo(todoId);
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

// POST /api/workspaces/:id/todos/:todoId/session
router.post('/:todoId/session', async (req, res) => {
  try {
    const workspaceId = (req.params as unknown as { id: string }).id;
    const todoId = req.params.todoId;

    const todo = store.getTodoById(todoId);
    if (!todo) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }

    if (todo.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Todo not found in this workspace' });
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

    const session = await chatService.createSession({ workspaceId, name: todo.text });
    store.linkTodoToSession(todoId, session.id);

    res.status(201).json(session);
  } catch (error) {
    console.error('Failed to create session from todo:', error);
    res.status(500).json({ error: 'Failed to create session from todo' });
  }
});

export default router;
