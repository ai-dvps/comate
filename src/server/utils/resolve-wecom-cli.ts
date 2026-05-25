import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';
import { sidecarLog } from './sidecar-logger.js';

/** Strip Windows extended-length path prefix so paths work with spawn/exec. */
function normalizeWindowsPath(p: string): string {
  if (process.platform === 'win32' && p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}

function tryPath(label: string, filePath: string): string | undefined {
  filePath = normalizeWindowsPath(filePath);
  sidecarLog(`[resolveWecomCliPath] ${label}: ${filePath}, exists=${existsSync(filePath)}`);
  if (existsSync(filePath)) {
    return filePath;
  }
  return undefined;
}

/**
 * Resolve the path to the wecom CLI bundled with the application.
 *
 * Tries multiple strategies to work in dev mode (tsx from source tree),
 * production (node from dist/), and in the pkg-bundled sidecar binary.
 */
export function resolveWecomCliPath(): string | undefined {
  // Strategy 1: resolve relative to this module (dev + production from dist/)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), '../../..');
    const found = tryPath('Strategy 1 (source tree)', path.join(projectRoot, 'packages', 'wecom-cli', 'dist', 'index.js'));
    if (found) return found;
  } catch (err) {
    sidecarLog(`[resolveWecomCliPath] Strategy 1 error: ${err}`);
  }

  // Strategy 2: CWD-relative fallbacks (dev mode, server run from project root)
  const cwdPaths = [
    path.resolve('packages/wecom-cli/dist/index.js'),
    path.resolve('../packages/wecom-cli/dist/index.js'),
  ];
  for (const p of cwdPaths) {
    const found = tryPath('Strategy 2 (CWD)', p);
    if (found) return found;
  }

  // Strategy 3: look next to the executable (pkg-bundled sidecar)
  const nextToExec = path.join(path.dirname(process.execPath), 'wecom-send.js');
  const found3 = tryPath('Strategy 3 (next to exec)', nextToExec);
  if (found3) return found3;

  // Strategy 4: Tauri resource directory (production builds and tauri:dev)
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    // Tauri resource_dir may return the resources root directly, or the parent dir
    const resourcePaths = [
      path.join(resourceDir, 'wecom-send.js'),
      path.join(resourceDir, 'resources', 'wecom-send.js'),
    ];
    for (const p of resourcePaths) {
      const found = tryPath('Strategy 4 (Tauri resources)', p);
      if (found) return found;
    }
  }

  sidecarLog(`[resolveWecomCliPath] No strategy succeeded, returning undefined`);
  return undefined;
}
