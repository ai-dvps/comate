import { Router } from 'express';
import type { Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import { scheduledTasksService, TaskValidationError } from '../services/scheduled-tasks-service.js';
import { SchedulerError } from '../services/scheduler-service.js';
import type { UpdateScheduledTaskInput } from '../models/scheduled-task.js';

const router = Router({ mergeParams: true });

/** Keys a PUT caller may edit; everything else (confirmedSnapshot, nextFireAt, id, workspaceId, deletedAt, timestamps) is dropped. */
const EDITABLE_KEYS = [
  'name',
  'instruction',
  'scheduleType',
  'scheduleTime',
  'cronExpr',
  'notifyDesktop',
  'notifyInApp',
  'notifyWecom',
  'wecomRecipient',
  'status',
] as const;

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

async function requireWorkspace(workspaceId: string | undefined): Promise<string | null> {
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
      const valid = await requireWorkspace(workspaceId);
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
    const workspaceId = await requireWorkspace((req.params as { id?: string }).id);
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
    const { id: workspaceId, taskId } = req.params as { id?: string; taskId: string };
    // Workspace-scoped mount enforces ownership; the global mount (panel) does not.
    const task = workspaceId
      ? scheduledTasksService.requireTaskInWorkspace(taskId, workspaceId)
      : scheduledTasksService.getTask(taskId);
    res.json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to get scheduled task');
  }
});

// PUT /api/workspaces/:id/scheduled-tasks/:taskId
router.put('/:taskId', async (req, res) => {
  try {
    const { id: workspaceId, taskId } = req.params as { id?: string; taskId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Whitelist user-editable keys: confirmedSnapshot is written only by
    // confirmTask (KTD-5) and nextFireAt only by the service's own recompute —
    // a raw-body pass-through would let callers rewrite both.
    const patch: UpdateScheduledTaskInput = {};
    for (const key of EDITABLE_KEYS) {
      if (body[key] !== undefined) {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }
    const task = scheduledTasksService.updateTask(taskId, patch, workspaceId);
    res.json({ task });
  } catch (error) {
    handleError(res, error, 'Failed to update scheduled task');
  }
});

// DELETE /api/workspaces/:id/scheduled-tasks/:taskId — soft delete (KTD-2)
router.delete('/:taskId', async (req, res) => {
  try {
    const { id: workspaceId, taskId } = req.params as { id?: string; taskId: string };
    scheduledTasksService.deleteTask(taskId, workspaceId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, 'Failed to delete scheduled task');
  }
});

// POST /api/workspaces/:id/scheduled-tasks/:taskId/run-now
router.post('/:taskId/run-now', async (req, res) => {
  try {
    const { id: workspaceId, taskId } = req.params as { id?: string; taskId: string };
    const run = await scheduledTasksService.runNow(taskId, workspaceId);
    res.status(201).json({ run });
  } catch (error) {
    handleError(res, error, 'Failed to run scheduled task');
  }
});

// GET /api/workspaces/:id/scheduled-tasks/:taskId/runs — execution history
router.get('/:taskId/runs', async (req, res) => {
  try {
    const { id: workspaceId, taskId } = req.params as { id?: string; taskId: string };
    const runs = scheduledTasksService.listRuns(taskId, workspaceId);
    res.json({ runs });
  } catch (error) {
    handleError(res, error, 'Failed to list task runs');
  }
});

export default router;
