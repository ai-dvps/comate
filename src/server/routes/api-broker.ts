import { Router } from 'express';
import { browserApiBrokerService } from '../services/browser-api-broker-service.js';
import { requireSessionAuth } from '../services/security/loopback-auth.js';

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
  } finally {
    req.off('aborted', onAborted);
    res.off('close', onClosed);
  }
});

export default router;
