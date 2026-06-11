import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';

function tryPath(label: string, filePath: string): string | undefined {
  filePath = normalizeWindowsPath(filePath);
  sidecarLog(`[resolveWecomCliPath] ${label}: ${filePath}, exists=${existsSync(filePath)}`);
  if (existsSync(filePath)) {
    return filePath;
  }
  return undefined;
}

function findInPath(command: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(cmd, args, { encoding: 'utf-8', shell: true });
  const lines = result.stdout?.trim().split('\n') || [];
  for (const line of lines) {
    const p = line.trim();
    if (p && existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

/**
 * Resolve the path to the wecom CLI binary.
 *
 * Strategy 1: Check if `wecom` is available in PATH (npm global install).
 * Strategy 2: Find the built CLI in the application bundle.
 */
export function resolveWecomCliPath(): string | undefined {
  // Strategy 1: npm global install
  const globalPath = findInPath('wecom');
  if (globalPath) {
    return globalPath;
  }

  // Strategy 2: resolve relative to this module (dev + production from dist/)
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), '../../..');
    const found = tryPath(
      'Strategy 2 (source tree)',
      path.join(projectRoot, 'packages', 'wecom-cli', 'dist', 'index.js'),
    );
    if (found) return found;
  } catch (err) {
    sidecarLog(`[resolveWecomCliPath] Strategy 2 error: ${err}`);
  }

  // Strategy 3: CWD-relative fallbacks
  const cwdPaths = [
    path.resolve('packages/wecom-cli/dist/index.js'),
    path.resolve('../packages/wecom-cli/dist/index.js'),
  ];
  for (const p of cwdPaths) {
    const found = tryPath('Strategy 3 (CWD)', p);
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
