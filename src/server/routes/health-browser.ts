import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  resolveSteelBundle,
  type SteelResolution,
} from '../utils/resolve-steel.js';
import {
  resolveChromium,
  type ChromiumResolution,
} from '../utils/resolve-chromium.js';
import { resolveBrowserCdpTarget, type BrowserCdpTarget } from '../services/browser-target.js';
import { fetchCdpBrowserInfo } from '../services/browser-cdp.js';
import { ShellControlClient } from '../services/browser-shell-client.js';
import { browserService } from '../services/browser-service.js';

/**
 * GET /api/health/browser — resolve-then-probe for the browser stack (mirrors
 * /api/health/claude). Never triggers the lazy Chromium download: a health
 * probe must stay cheap; first browser tool use drives download (F5).
 *
 * U7 failure classification (replacing Steel-only messaging for native
 * sessions): the payload carries a machine-readable `code` plus an actionable
 * `error` for each shell-side failure mode —
 *  - `control_channel_unreachable`: the shell's KTD-11 control channel does
 *    not answer (app not running as the desktop shell, dev-web mode, or a
 *    crashed main process);
 *  - `debug_port_unreachable`: the control channel is fine but the shell's
 *    Chromium debug port does not answer /json/version (or, for
 *    COMATE_BROWSER_CDP_TARGET endpoints, the external Chromium is gone);
 *  - `view_creation_failed`: both probes pass but the last view creation
 *    failed (recorded by browser-service at spawn time);
 *  - `target_misconfigured`: COMATE_BROWSER_CDP_TARGET is set but unworkable.
 *
 * Steel mode (pre-U9 fallback, dev-web) keeps the legacy resolve+probe
 * behavior and payload shape.
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
  /** Legacy Steel-stack deps (kept until U9). */
  resolveSteel: () => SteelResolution | undefined;
  resolveChromium: () => Promise<ChromiumResolution | undefined>;
  probeChromium: (executablePath: string) => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function defaultProbeChromium(executablePath: string): Promise<string> {
  const { stdout } = await execFileAsync(executablePath, ['--version'], { timeout: 5000 });
  return stdout.trim();
}

/** Resolution details echoed in both the 503 and the probe-failure payloads. */
function resolutionDetails(
  steel: SteelResolution | undefined,
  chromium: ChromiumResolution | undefined,
): Record<string, unknown> {
  return {
    steel: steel ? { source: steel.source, steelDir: steel.steelDir } : null,
    chromium: chromium
      ? { source: chromium.source, executablePath: chromium.executablePath }
      : null,
  };
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
    resolveSteel: () => resolveSteelBundle(),
    resolveChromium: () => resolveChromium({ allowDownload: false }),
    probeChromium: defaultProbeChromium,
    ...overrides,
  };

  const router = Router();

  router.get('/', async (_req, res) => {
    const target = deps.resolveTarget();
    if (target.kind === 'steel') {
      await handleSteel(deps, res);
      return;
    }
    await handleNative(deps, res, target);
  });

  return router;
}

async function handleNative(
  deps: HealthBrowserDeps,
  res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void },
  target: Exclude<BrowserCdpTarget, { kind: 'steel' }>,
): Promise<void> {
  const fail = (code: BrowserHealthFailureCode, error: string, details: Record<string, unknown>) => {
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
        'the desktop app, or set COMATE_BROWSER_CDP_TARGET=steel / a CDP endpoint for the legacy/fallback stack.',
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
        'Workaround: COMATE_BROWSER_CDP_TARGET=steel or an external CDP endpoint.',
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
}

async function handleSteel(
  deps: HealthBrowserDeps,
  res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void },
): Promise<void> {
  const steel = deps.resolveSteel();
  const chromium = await deps.resolveChromium();

  if (!steel || !chromium) {
    const problems: string[] = [];
    if (!steel) {
      problems.push(
        'Steel bundle not found (searched TAURI_RESOURCE_DIR, the app data ' +
          'directory, and the dev resources tree). Reinstall the app, or run ' +
          '`npm run build:steel` in a dev checkout.',
      );
    }
    if (!chromium) {
      problems.push(
        'No Chromium executable found. The bundled Chrome for Testing is ' +
          'missing — reinstall the app, set COMATE_CHROMIUM_PATH to a ' +
          'Chrome/Chromium executable, or set COMATE_USE_SYSTEM_CHROME=1 to ' +
          'drive your installed Chrome on first browser use.',
      );
    }
    res.status(503).json({
      ok: false,
      error: problems.join(' '),
      message: 'Embedded browser runtime is not ready.',
      details: resolutionDetails(steel, chromium),
    });
    return;
  }

  try {
    const versionOutput = await deps.probeChromium(chromium.executablePath);
    res.json({
      ok: true,
      details: {
        steel: { source: steel.source, steelDir: steel.steelDir },
        chromium: {
          source: chromium.source,
          executablePath: chromium.executablePath,
          version: chromium.version ?? versionOutput,
        },
      },
    });
  } catch {
    res.status(503).json({
      ok: false,
      error:
        `Chromium at ${chromium.executablePath} failed to execute \`--version\`. ` +
        'Reinstall the browser, point COMATE_CHROMIUM_PATH at a working ' +
        'executable, or remove it so the pinned download can be used.',
      message: 'Chromium resolved but failed to launch.',
      details: resolutionDetails(steel, chromium),
    });
  }
}

export default createHealthBrowserRouter();
