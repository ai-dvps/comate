import { Router } from 'express';
import type { Response } from 'express';
import { store } from '../storage/sqlite-store.js';
import {
  getConnectionStatus,
  startDeviceFlow,
  pollDeviceFlow,
  connectPat,
  disconnect,
  getAdapter,
  GithubAuthError,
} from '../services/github-auth.js';
import { redactGithubError } from '../services/github-types.js';
import { diagLog } from '../utils/diag-logger.js';

const router = Router();

/**
 * Redact every GitHub-derived error before it reaches a logger or response
 * (R13/KTD3). Expected auth errors carry clean messages; unexpected errors are
 * sanitized and logged via diagLog (never console, never the raw object).
 */
function handleGithubError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof GithubAuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const redacted = redactGithubError(err);
  diagLog('[github] ' + fallback + ': ' + JSON.stringify(redacted));
  res.status(500).json({ error: fallback });
}

// GET /api/github/connection — status only; never a token (R18).
router.get('/connection', (_req, res) => {
  try {
    res.json({ connection: getConnectionStatus() });
  } catch (err) {
    handleGithubError(res, err, 'Failed to read GitHub connection');
  }
});

// POST /api/github/device-flow/start — begin Device Flow; verification URI verbatim.
router.post('/device-flow/start', async (_req, res) => {
  try {
    const start = await startDeviceFlow();
    res.status(201).json(start);
  } catch (err) {
    handleGithubError(res, err, 'Failed to start GitHub device flow');
  }
});

// POST /api/github/device-flow/poll — one poll; on success, return the new status.
router.post('/device-flow/poll', async (_req, res) => {
  try {
    const result = await pollDeviceFlow();
    res.json({ ...result, connection: getConnectionStatus() });
  } catch (err) {
    handleGithubError(res, err, 'Failed to poll GitHub device flow');
  }
});

// POST /api/github/connect/pat — PAT paste fallback (KTD1). Body: { token }.
router.post('/connect/pat', async (req, res) => {
  try {
    const token = (req.body as { token?: string } | undefined)?.token;
    const status = connectPat(token ?? '');
    res.status(201).json({ connection: status });
  } catch (err) {
    handleGithubError(res, err, 'Failed to store GitHub PAT');
  }
});

// POST /api/github/disconnect — clear local state + best-effort revoke (R18).
router.post('/disconnect', async (_req, res) => {
  try {
    const result = await disconnect();
    res.json({ ok: true, ...result, connection: getConnectionStatus() });
  } catch (err) {
    handleGithubError(res, err, 'Failed to disconnect GitHub');
  }
});

// GET /api/github/repos — accessible repos; per-repo `private` preserved (R17).
router.get('/repos', async (_req, res) => {
  try {
    const adapter = await getAdapter();
    if (!adapter) {
      res.status(400).json({ error: 'Not connected to GitHub' });
      return;
    }
    const repos = await adapter.listAccessibleRepos();
    res.json({ repos });
  } catch (err) {
    handleGithubError(res, err, 'Failed to list GitHub repositories');
  }
});

// GET /api/github/workspaces/:workspaceId/repos — associated repos for a workspace.
router.get('/workspaces/:workspaceId/repos', async (req, res) => {
  try {
    const workspaceId = req.params.workspaceId;
    if (!(await store.get(workspaceId))) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ repos: store.getWorkspaceGithubRepos(workspaceId) });
  } catch (err) {
    handleGithubError(res, err, 'Failed to read workspace GitHub repositories');
  }
});

// PUT /api/github/workspaces/:workspaceId/repos — replace the association. Body: { repos: string[] }.
router.put('/workspaces/:workspaceId/repos', async (req, res) => {
  try {
    const workspaceId = req.params.workspaceId;
    if (!(await store.get(workspaceId))) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const body = req.body as { repos?: unknown } | undefined;
    const repos = Array.isArray(body?.repos) ? (body!.repos as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    const stored = store.setWorkspaceGithubRepos(workspaceId, repos);
    res.json({ repos: stored });
  } catch (err) {
    handleGithubError(res, err, 'Failed to set workspace GitHub repositories');
  }
});

export default router;
