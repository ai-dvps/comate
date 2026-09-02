import { Router } from 'express';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import {
  GitGraphUnavailableError,
  GitGraphValidationError,
  gitGraphService,
} from '../services/git-graph-service.js';
import { diagWarn } from '../utils/diag-logger.js';
import { gitRepositoryService } from '../services/git-repository-service.js';

const router = Router({ mergeParams: true });

function queryRepositoryId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new GitGraphValidationError('Invalid repositoryId');
  }
  return value;
}

router.get('/repositories', async (req, res) => {
  try {
    const workspaceId = (req.params as { id: string }).id;
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) { res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' }); return; }
    if (req.query.refresh !== undefined && req.query.refresh !== 'true') {
      throw new GitGraphValidationError('refresh must be true');
    }
    res.json(await gitRepositoryService.discover(workspaceId, workspace.folderPath, req.query.refresh === 'true'));
  } catch (error) {
    if (error instanceof GitGraphValidationError) {
      res.status(400).json({ error: error.message, code: 'INVALID_GIT_GRAPH_REQUEST' });
      return;
    }
    res.status(500).json({ error: 'Unable to discover Workspace repositories', code: 'GIT_REPOSITORIES_FAILED' });
  }
});

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

    const options = {
      limit: queryLimit(req.query.limit),
      refs: queryRefs(req.query.ref),
    };
    const repository = await gitRepositoryService.resolve(workspaceId, workspace.folderPath, queryRepositoryId(req.query.repositoryId));
    const snapshot = await gitGraphService.getSnapshot(repository.folderPath, options);
    res.json({ ...snapshot, repositoryId: repository.id });
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

// Keep the more-specific historical Diff route before the commit-detail route.
router.get('/:hash/diff', async (req, res) => {
  try {
    const { id: workspaceId, hash } = req.params as { id: string; hash: string };
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }
    const requestedPath = req.query.path;
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      throw new GitGraphValidationError('path is required');
    }
    const repository = await gitRepositoryService.resolve(workspaceId, workspace.folderPath, queryRepositoryId(req.query.repositoryId));
    res.json({ ...await gitGraphService.getFileComparison(repository.folderPath, hash, requestedPath, repository.id), repositoryId: repository.id });
  } catch (error) {
    if (error instanceof GitGraphValidationError) {
      res.status(400).json({ error: error.message, code: 'INVALID_GIT_GRAPH_REQUEST' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-graph] failed to get historical diff:', message);
    if (error instanceof GitGraphUnavailableError) {
      res.status(409).json({ error: error.message, code: 'GIT_GRAPH_UNAVAILABLE' });
      return;
    }
    res.status(500).json({ error: 'Failed to get historical Git diff', code: 'GIT_GRAPH_DIFF_FAILED' });
  }
});

router.get('/:hash', async (req, res) => {
  try {
    const { id: workspaceId, hash } = req.params as { id: string; hash: string };
    const workspace = await workspaceStore.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
      return;
    }
    const repository = await gitRepositoryService.resolve(workspaceId, workspace.folderPath, queryRepositoryId(req.query.repositoryId));
    res.json({ ...await gitGraphService.getCommitDetail(repository.folderPath, hash, repository.id), repositoryId: repository.id });
  } catch (error) {
    if (error instanceof GitGraphValidationError) {
      res.status(400).json({ error: error.message, code: 'INVALID_GIT_GRAPH_REQUEST' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    diagWarn('[git-graph] failed to get commit detail:', message);
    if (error instanceof GitGraphUnavailableError) {
      res.status(409).json({ error: error.message, code: 'GIT_GRAPH_UNAVAILABLE' });
      return;
    }
    res.status(500).json({ error: 'Failed to get Git commit detail', code: 'GIT_GRAPH_DETAIL_FAILED' });
  }
});

export default router;
