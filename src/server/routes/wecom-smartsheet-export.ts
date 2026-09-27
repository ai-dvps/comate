import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomDocService } from '../services/wecom-doc-service.js';
import { requireSessionAuth } from '../services/security/loopback-auth.js';

const router = Router({ mergeParams: true });

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// POST /api/workspaces/:workspaceId/wecom/smartsheet-export
router.post('/', async (req, res) => {
  try {
    // U12 (KTD-28): a session capability token is required; the middleware
    // has already bound it to this workspace.
    const auth = requireSessionAuth(req, res);
    if (!auth) return;

    const workspaceId = auth.workspaceId;

    const docid = (req.body as { docid?: unknown } | undefined)?.docid;
    if (typeof docid !== 'string' || docid.trim().length === 0) {
      res.status(400).json({ error: 'docid is required' });
      return;
    }

    const workspace = await store.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'workspace_not_found' });
      return;
    }

    const buffer = await wecomDocService.exportSmartsheetWorkbook(workspace, docid);

    res.status(200).set('Content-Type', XLSX_CONTENT_TYPE).send(buffer);
  } catch (error) {
    console.error('[WeComSmartsheetExport] Failed to export smartsheet workbook:', error);
    const message = error instanceof Error ? error.message : 'Failed to export smartsheet workbook';
    res.status(500).json({ error: 'smartsheet_export_failed', message });
  }
});

export default router;
