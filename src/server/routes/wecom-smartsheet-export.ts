import { Router } from 'express';
import { store } from '../storage/sqlite-store.js';
import { wecomDocService } from '../services/wecom-doc-service.js';

const router = Router({ mergeParams: true });

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// POST /api/workspaces/:workspaceId/wecom/smartsheet-export
router.post('/', async (req, res) => {
  try {
    const workspaceId = (req.params as { workspaceId: string }).workspaceId;

    if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      res.status(400).json({ error: 'workspaceId is required' });
      return;
    }

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
