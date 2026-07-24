import { Router } from 'express';
import type { Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import { scheduledTasksService } from '../services/scheduled-tasks-service.js';
import { TaskValidationError } from '../services/scheduled-tasks-service.js';
import { SchedulerError } from '../services/scheduler-service.js';

const router = Router({ mergeParams: true });

function handleError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof TaskValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof SchedulerError) {
    res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.message });
    return;
  }
  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

async function requireWorkspace(req: { params: unknown }): Promise<string | null> {
  const workspaceId = (req.params as { id?: string }).id;
  if (!workspaceId) return null;
  const ws = await store.get(workspaceId);
  return ws ? workspaceId : null;
}

// GET /api/scheduled-tasks (global list for the panel) or
// GET /api/workspaces/:id/scheduled-tasks (workspace-scoped list)
router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id?: string }).id;
    if (workspaceId) {
      const valid = await requireWorkspace(req);
      if (!valid) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
    }
    const tasks = scheduledTasksService.listTasks(workspaceId);
    res.json({ tasks });
  } catch (error) {
    handleError(res, error, 'Failed to list scheduled tasks');
  }
});

// POST /api/workspaces/:id/scheduled-tasks — local UI creation (active immediately)
router.post('/', async (req, res) => {
  try {
    const workspaceId = await requireWorkspace(req);
    if (!workspaceId) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body.name !== 'string' || typeof body.instruction !== 'string' || typeof body.scheduleType !== 'string') {
      res.status(400).json({ error: 'name, instruction and scheduleType are required' });
      return;
    }
    const task = await scheduledTasksService.createTask(workspaceId, {
      workspaceId,
      name: body.name,
      instruction: body.instruction,
      scheduleType: body.scheduleType as 'once' | 'recurring',
      scheduleTime: (body.scheduleTime as string | null) ?? null,
      cronExpr: (body.cronExpr as string | null) ?? null,
      notifyDesktop: body.notifyDesktop !== false,
      notifyInApp: body.notifyInApp !== false,
      notifyWecom: body.notifyWecom === true,
      wecomRecipient: (body.wecomRecipient as string | null) ?? null,
    });
    res.status(201).json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to create scheduled task');
  }
});

// GET /api/workspaces/:id/scheduled-tasks/:taskId
router.get('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    const task = scheduledTasksService.getTask(taskId);
    res.json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to get scheduled task');
  }
});

// PUT /api/workspaces/:id/scheduled-tasks/:taskId
router.put('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = scheduledTasksService.updateTask(taskId, body);
    res.json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to update scheduled task');
  }
});

// DELETE /api/workspaces/:id/scheduled-tasks/:taskId — soft delete (KTD-2)
router.delete('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    scheduledTasksService.deleteTask(taskId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 'Failed to delete scheduled task');
  }
});

// POST /api/workspaces/:id/scheduled-tasks/:taskId/confirm — draft → active (R6)
router.post('/:taskId/confirm', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    const task = await scheduledTasksService.confirmTask(taskId);
    res.json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to confirm scheduled task');
  }
});

// POST /api/workspaces/:id/scheduled-tasks/:taskId/run-now
router.post('/:taskId/run-now', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    const run = await scheduledTasksService.runNow(taskId);
    res.status(201).json({ run });
  } catch (error) {
    handleError(res, error, 'Failed to run scheduled task');
  }
});

// GET /api/workspaces/:id/scheduled-tasks/:taskId/runs — execution history
router.get('/:taskId/runs', async (req, res) => {
  try {
    const { taskId } = req.params as { taskId: string };
    const runs = scheduledTasksService.listRuns(taskId);
    res.json({ runs });
  } catch (error) {
    handleError(res, error, 'Failed to list task runs');
  }
});

export default router;
