import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomDocService } from '../services/wecom-doc-service.js';
import { requireSessionAuth } from '../services/security/loopback-auth.js';

const router = Router({ mergeParams: true });

// POST /api/workspaces/:workspaceId/wecom/doc/:tool
router.post('/', async (req, res) => {
  try {
    // U12 (KTD-28): a session capability token is required; the middleware
    // has already bound it to this workspace.
    const auth = requireSessionAuth(req, res);
    if (!auth) return;

    const workspaceId = auth.workspaceId;
    const tool = (req.params as { tool: string }).tool;

    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    const params = req.body ?? {};

    const result = await wecomDocService.callTool(workspace, tool, params);

    res.status(200).json(result);
  } catch (error) {
    console.error('[WeComDoc] Failed to process doc request:', error);
    const message = error instanceof Error ? error.message : 'Failed to process doc request';
    res.status(500).json({ error: 'doc_request_failed', message });
  }
});

export default router;
