import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { findInPath } from './find-in-path.js';

function tryPath(label: string, filePath: string): string | undefined {
  filePath = normalizeWindowsPath(filePath);
  sidecarLog(`[resolveWecomCliPath] ${label}: ${filePath}, exists=${existsSync(filePath)}`);
  if (existsSync(filePath)) {
    return filePath;
  }
  return undefined;
}

function resourceTriple(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

/**
 * Resolve the path to the wecom CLI binary.
 *
 * Strategy 1: Prefer the CLI staged with the Electron sidecar build.
 * Strategy 2: Check if `wecom` is available in PATH (npm install/global install).
 * Strategy 3: Find the built CLI in the development source tree.
 */
export function resolveWecomCliPath(): string | undefined {
  // Strategy 1: Electron dev/packaged resource staged by build-sidecar.ts.
  if (process.env.TAURI_RESOURCE_DIR) {
    const found = tryPath(
      'Strategy 1 (sidecar resources)',
      path.join(
        process.env.TAURI_RESOURCE_DIR,
        'wecom-cli',
        resourceTriple(),
        process.platform === 'win32' ? 'wecom.exe' : 'wecom',
      ),
    );
    if (found) return found;
  }

  // Strategy 2: npm install/global install
  const globalPath = findInPath('wecom');
  if (globalPath) {
    return globalPath;
  }

  // Strategy 3: resolve relative to this module (development from dist/)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), '../../..');
    const found = tryPath(
      'Strategy 3 (source tree)',
      path.join(projectRoot, 'packages', 'wecom-cli', 'dist', 'index.js'),
    );
    if (found) return found;
  } catch (err) {
    sidecarLog(`[resolveWecomCliPath] Strategy 3 error: ${err}`);
  }

  // Strategy 4: CWD-relative fallbacks
  const cwdPaths = [
    path.resolve('packages/wecom-cli/dist/index.js'),
    path.resolve('../packages/wecom-cli/dist/index.js'),
  ];
  for (const p of cwdPaths) {
    const found = tryPath('Strategy 4 (CWD)', p);
    if (found) return found;
  }

  sidecarLog(`[resolveWecomCliPath] No strategy succeeded, returning undefined`);
  return undefined;
}

/**
 * Resolve the wecom-cli package directory for npm global install.
 */
export function resolveWecomCliPackageDir(): string | undefined {
  // Strategy 1: resolve relative to this module
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), '../../..');
    const pkgDir = path.join(projectRoot, 'packages', 'wecom-cli');
    if (existsSync(path.join(pkgDir, 'package.json'))) {
      return pkgDir;
    }
  } catch (err) {
    sidecarLog(`[resolveWecomCliPackageDir] Strategy 1 error: ${err}`);
  }

  // Strategy 2: CWD-relative
  const cwdPaths = [path.resolve('packages/wecom-cli'), path.resolve('../packages/wecom-cli')];
  for (const p of cwdPaths) {
    if (existsSync(path.join(p, 'package.json'))) {
      return p;
    }
  }

  sidecarLog(`[resolveWecomCliPackageDir] No strategy succeeded, returning undefined`);
  return undefined;
}
