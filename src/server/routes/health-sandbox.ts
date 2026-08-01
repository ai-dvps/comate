import { Router } from 'express';
import {
  ensureSandboxProbe,
  type SandboxProbeResult,
} from '../services/sandbox-probe.js';

/**
 * GET /api/health/sandbox — exposes the spawn-probe state machine (U3,
 * KTD-24) to the desktop client. Mirrors the /api/health/browser
 * resolve-then-probe contract: 200 when the host enforces the sandbox,
 * 503 with the failed negative assertions when it does not. The desktop
 * renders a persistent workspace-level banner while degraded; the banner's
 * re-check button hits `?refresh=1`, which forces a re-probe — the only way
 * the banner clears is a passing probe.
 */

export interface HealthSandboxDeps {
  ensureProbe: (options?: { forceRefresh?: boolean }) => Promise<SandboxProbeResult>;
}

export function createHealthSandboxRouter(overrides?: Partial<HealthSandboxDeps>): Router {
  const deps: HealthSandboxDeps = {
    ensureProbe: ensureSandboxProbe,
    ...overrides,
  };

  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const probe = await deps.ensureProbe({ forceRefresh: req.query?.refresh === '1' });
      if (probe.ok) {
        res.json({ ok: true, probe });
        return;
      }
      res.status(503).json({
        ok: false,
        error:
          'The execution sandbox failed its spawn probe on this host ' +
          `(${probe.failures.join(', ')}). Bot sessions run in the degraded ` +
          'permission posture: regular members cannot run shell commands until ' +
          'the probe passes.',
        message: 'Bot execution sandbox is unavailable; degraded permission posture active.',
        probe,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: `Sandbox probe failed to run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  return router;
}

export default createHealthSandboxRouter();
