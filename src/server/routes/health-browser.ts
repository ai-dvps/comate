import { Router } from 'express';
import { resolveBrowserCdpTarget, type BrowserCdpTarget } from '../services/browser-target.js';
import { fetchCdpBrowserInfo } from '../services/browser-cdp.js';
import { ShellControlClient } from '../services/browser-shell-client.js';
import { browserService } from '../services/browser-service.js';

/**
 * GET /api/health/browser — resolve-then-probe for the browser stack (mirrors
 * /api/health/claude). A health probe stays cheap: it never creates views.
 *
 * Failure classification (KTD-15): the payload carries a machine-readable
 * `code` plus an actionable `error` for each shell-side failure mode —
 *  - `control_channel_unreachable`: the shell's KTD-11 control channel does
 *    not answer (app not running as the desktop shell, dev-web mode, or a
 *    crashed main process);
 *  - `debug_port_unreachable`: the control channel is fine but the shell's
 *    Chromium debug port does not answer /json/version (or, for
 *    COMATE_BROWSER_CDP_TARGET endpoints, the external Chromium is gone);
 *  - `view_creation_failed`: both probes pass but the last view creation
 *    failed (recorded by browser-service at spawn time);
 *  - `target_misconfigured`: no usable CDP target — dev-web without the
 *    desktop app, or COMATE_BROWSER_CDP_TARGET set but unworkable.
 *
 * U9 (R8 decision): the operator fallback referenced below is
 * COMATE_BROWSER_CDP_TARGET pointing at an external debug-port Chromium —
 * no client re-release needed (AE2), aimed at support/enterprise-ops use.
 */

export type BrowserHealthFailureCode =
  | 'control_channel_unreachable'
  | 'debug_port_unreachable'
  | 'view_creation_failed'
  | 'target_misconfigured';

export interface ShellErrorRecord {
  kind: 'control_channel' | 'view_creation' | 'debug_port';
  message: string;
  at: number;
}

export interface HealthBrowserDeps {
  /** U7: which CDP target is active (defaults to env resolution). */
  resolveTarget: () => BrowserCdpTarget;
  /** U7: probe the shell control channel (GET /health with the boot token). */
  probeControlChannel: (endpoint: {
    controlPort: number;
    controlToken: string;
  }) => Promise<{ ok: boolean; quitting?: boolean }>;
  /** U7: probe a debug port's /json/version. */
  probeDebugPort: (address: {
    host?: string;
    port: number;
  }) => Promise<{ product?: string }>;
  /** U7: the last native-path failure recorded by browser-service. */
  lastShellError: () => ShellErrorRecord | undefined;
}

export function createHealthBrowserRouter(overrides?: Partial<HealthBrowserDeps>): Router {
  const deps: HealthBrowserDeps = {
    resolveTarget: () => resolveBrowserCdpTarget(process.env),
    probeControlChannel: async (endpoint) => {
      const client = new ShellControlClient({
        port: endpoint.controlPort,
        token: endpoint.controlToken,
      });
      return client.health();
    },
    probeDebugPort: (address) => fetchCdpBrowserInfo(address),
    lastShellError: () => browserService.getLastShellError(),
    ...overrides,
  };

  const router = Router();

  router.get('/', async (_req, res) => {
    const target = deps.resolveTarget();
    const fail = (
      code: BrowserHealthFailureCode,
      error: string,
      details: Record<string, unknown>,
    ) => {
      res.status(503).json({ ok: false, code, error, message: error, details });
    };

    if (target.kind === 'misconfigured') {
      fail('target_misconfigured', target.reason, { target: 'misconfigured' });
      return;
    }

    if (target.kind === 'external') {
      try {
        const info = await deps.probeDebugPort({ host: target.host, port: target.port });
        res.json({
          ok: true,
          details: {
            target: 'external',
            endpoint: `${target.host}:${target.port}`,
            product: info.product ?? null,
          },
        });
      } catch (err) {
        fail(
          'debug_port_unreachable',
          `The external CDP endpoint at ${target.host}:${target.port} does not answer: ` +
            `${err instanceof Error ? err.message : String(err)}. Start the fallback Chromium ` +
            '(e.g. `chrome --remote-debugging-port=<port> --remote-debugging-address=127.0.0.1`), ' +
            'fix COMATE_BROWSER_CDP_TARGET, or unset it to return to the default stack.',
          { target: 'external', endpoint: `${target.host}:${target.port}` },
        );
      }
      return;
    }

    // Shell target: control channel first, then the debug port, then the last
    // recorded view-creation failure.
    try {
      await deps.probeControlChannel({
        controlPort: target.controlPort,
        controlToken: target.controlToken,
      });
    } catch (err) {
      fail(
        'control_channel_unreachable',
        `The desktop shell's browser control channel does not answer on 127.0.0.1:${target.controlPort}: ` +
          `${err instanceof Error ? err.message : String(err)}. Restart the desktop app. If this ` +
          'sidecar is running in dev-web mode there is no shell — the embedded browser requires ' +
          'the desktop app, or set COMATE_BROWSER_CDP_TARGET to an external CDP endpoint for the fallback stack.',
        { target: 'shell', controlPort: target.controlPort },
      );
      return;
    }

    let product: string | undefined;
    try {
      const info = await deps.probeDebugPort({ port: target.debugPort });
      product = info.product;
    } catch (err) {
      fail(
        'debug_port_unreachable',
        `The shell's Chromium debug port does not answer on 127.0.0.1:${target.debugPort}: ` +
          `${err instanceof Error ? err.message : String(err)}. Restart the desktop app; if it ` +
          'persists, check the shell log for "debug port" and report the startup failure. ' +
          'Workaround: COMATE_BROWSER_CDP_TARGET pointing at an external CDP endpoint.',
        { target: 'shell', debugPort: target.debugPort },
      );
      return;
    }

    const lastError = deps.lastShellError();
    if (lastError) {
      const code: BrowserHealthFailureCode =
        lastError.kind === 'view_creation'
          ? 'view_creation_failed'
          : lastError.kind === 'control_channel'
            ? 'control_channel_unreachable'
            : 'debug_port_unreachable';
      fail(
        code,
        `Browser views are failing in the desktop shell (${lastError.kind}): ${lastError.message}. ` +
          'Restart the desktop app; if it persists, capture the shell log and report the failure.',
        { target: 'shell', debugPort: target.debugPort, lastError },
      );
      return;
    }

    res.json({
      ok: true,
      details: {
        target: 'shell',
        debugPort: target.debugPort,
        controlPort: target.controlPort,
        product: product ?? null,
      },
    });
  });

  return router;
}

export default createHealthBrowserRouter();
