import { Router } from 'express';
import { checkWecomCliInstallation, installWecomCli, uninstallWecomCli } from '../utils/install-wecom-cli.js';

const router = Router();

// GET /api/cli/status
router.get('/status', (_req, res) => {
  const result = checkWecomCliInstallation();
  res.json(result);
});

// POST /api/cli/install
router.post('/install', (_req, res) => {
  const result = installWecomCli();
  if (result.installed) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

// POST /api/cli/uninstall
router.post('/uninstall', (_req, res) => {
  const result = uninstallWecomCli();
  res.json(result);
});

export default router;
