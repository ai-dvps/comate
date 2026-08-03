import { Router } from 'express';
import { browserApiBrokerService } from '../services/browser-api-broker-service.js';
import { requireSessionAuth } from '../services/security/loopback-auth.js';
import { diagWarn } from '../utils/diag-logger.js';

export const API_BROKER_REQUEST_PATH = '/api/broker/request';

const router = Router();

router.post('/', async (req, res) => {
  const auth = requireSessionAuth(req, res);
  if (!auth) return;
  if (!auth.runtimeGeneration) {
    res.status(403).json({ error: 'forbidden', message: 'This task capability has no live runtime generation.' });
    return;
  }

  const abort = new AbortController();
  const onAborted = () => abort.abort();
  const onClosed = () => {
    if (!res.writableEnded) abort.abort();
  };
  req.once('aborted', onAborted);
  res.once('close', onClosed);
  try {
    const result = await browserApiBrokerService.execute({
      taskId: auth.sessionId,
      workspaceId: auth.workspaceId,
      grantScope: auth.runtimeGeneration,
      signal: abort.signal,
    }, req.body);
    res.json(result);
  } catch (error) {
    // Unexpected broker errors may carry request-derived text. Log only the
    // error class so credentials can never escape through diagnostics.
    diagWarn('[api-broker] request failed:', error instanceof Error ? error.name : 'non_error_rejection');
    if (!res.headersSent) {
      res.status(500).json({ error: 'broker_failed', message: 'Broker request failed.' });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    req.off('aborted', onAborted);
    res.off('close', onClosed);
  }
});

export default router;
