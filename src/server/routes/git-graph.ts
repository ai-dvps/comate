import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import {
  GitGraphUnavailableError,
  GitGraphValidationError,
  gitGraphService,
} from '../services/git-graph-service.js';
import { diagWarn } from '../utils/diag-logger.js';

const router = Router({ mergeParams: true });

function queryRefs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  throw new GitGraphValidationError('ref must be a string or repeated string query');
}

function queryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new GitGraphValidationError('limit must be an integer');
  }
  return Number(value);
}

router.get('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }

    const snapshot = await gitGraphService.getSnapshot(workspace.folderPath, {
      limit: queryLimit(req.query.limit),
      refs: queryRefs(req.query.ref),
    });
    res.json(snapshot);
  } catch (error) {
    if (error instanceof GitGraphValidationError) {
      res.status(400).json({ error: error.message, code: 'INVALID_GIT_GRAPH_REQUEST' });
      return;
    }
    if (error instanceof GitGraphUnavailableError) {
      res.status(409).json({ error: error.message, code: 'GIT_GRAPH_UNAVAILABLE' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-graph] failed to get snapshot:', message);
    res.status(500).json({ error: 'Failed to get Git graph', code: 'GIT_GRAPH_FAILED' });
  }
});

export default router;
