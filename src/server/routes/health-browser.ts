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

/**
 * GET /api/health/browser — resolve-then-probe for the embedded browser stack
 * (mirrors /api/health/claude). Never triggers the lazy Chromium download:
 * a health probe must stay cheap; first browser tool use drives download (F5).
 *
 * 200 when both the vendored Steel bundle and a Chromium executable resolve
 * and Chromium answers `--version`; 503 with an actionable message otherwise
 * (R17/AE5: explicit error + resolution path, never silent).
 */

export interface HealthBrowserDeps {
  resolveSteel: () => SteelResolution | undefined;
  resolveChromium: () => Promise<ChromiumResolution | undefined>;
  probeChromium: (executablePath: string) => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function defaultProbeChromium(executablePath: string): Promise<string> {
  const { stdout } = await execFileAsync(executablePath, ['--version'], { timeout: 5000 });
  return stdout.trim();
}

export function createHealthBrowserRouter(overrides?: Partial<HealthBrowserDeps>): Router {
  const deps: HealthBrowserDeps = {
    resolveSteel: () => resolveSteelBundle(),
    resolveChromium: () => resolveChromium({ allowDownload: false }),
    probeChromium: defaultProbeChromium,
    ...overrides,
  };

  const router = Router();

  router.get('/', async (_req, res) => {
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
          'No Chromium executable found. Install Google Chrome or Microsoft ' +
            'Edge, set COMATE_CHROMIUM_PATH, or let Comate download the pinned ' +
            'Chrome for Testing build on first browser use.',
        );
      }
      res.status(503).json({
        ok: false,
        error: problems.join(' '),
        message: 'Embedded browser runtime is not ready.',
        details: {
          steel: steel ? { source: steel.source, steelDir: steel.steelDir } : null,
          chromium: chromium
            ? { source: chromium.source, executablePath: chromium.executablePath }
            : null,
        },
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
        details: {
          steel: { source: steel.source, steelDir: steel.steelDir },
          chromium: { source: chromium.source, executablePath: chromium.executablePath },
        },
      });
    }
  });

  return router;
}

export default createHealthBrowserRouter();
