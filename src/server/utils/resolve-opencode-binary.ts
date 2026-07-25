/**
 * Resolve the opencode CLI binary bundled via the pinned platform
 * optionalDependencies (opencode-{platform}-{arch}), mirroring
 * resolve-sdk-binary.ts so both agent runtimes share one resolution shape:
 * dev-tree require, next-to-exec, CWD node_modules, Tauri resource dir.
 */

import { createRequire } from 'module';
import path from 'path';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';

/**
 * The opencode binary + @opencode-ai/sdk version pinned as ONE compatibility
 * unit (doc-review): the adapter validates the serve process against this at
 * startup so protocol drift (e.g. permission.asked ↔ permission.updated)
 * fails loudly instead of silently mismatching.
 */
export const OPENCODE_EXPECTED_VERSION = '1.18.4';

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const OPENCODE_BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

const require = createRequire(import.meta.url);

function tryResolve(packageName: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(packageName);
  } catch (err) {
    sidecarLog(`[resolveOpencodeBinary] Strategy 1 error resolving ${packageName}: ${err}`);
    return undefined;
  }
}

function tryFile(filePath: string): boolean {
  try {
    const { existsSync } = require('fs');
    return existsSync(filePath);
  } catch {
    return false;
  }
}

export function resolveOpencodeBinary(): string | undefined {
  // Strategy 1: resolve via require from the source tree (dev mode)
  const pkgName = `opencode-${PLATFORM_ARCH}`;
  let resolved = tryResolve(`${pkgName}/package.json`);

  if (!resolved && process.platform === 'linux') {
    resolved = tryResolve(`${pkgName}-musl/package.json`);
  }

  if (resolved) {
    const binaryPath = normalizeWindowsPath(path.join(path.dirname(resolved), 'bin', OPENCODE_BINARY_NAME));
    sidecarLog(`[resolveOpencodeBinary] Strategy 1 (require.resolve): ${binaryPath}`);
    return binaryPath;
  }

  // Strategy 2: look next to the executable (pkg-bundled sidecar)
  const nextToExec = normalizeWindowsPath(path.join(path.dirname(process.execPath), OPENCODE_BINARY_NAME));
  sidecarLog(`[resolveOpencodeBinary] Strategy 2 (next to exec): ${nextToExec}, exists=${tryFile(nextToExec)}`);
  if (tryFile(nextToExec)) {
    return nextToExec;
  }

  // Strategy 3: look in CWD/node_modules and CWD/../node_modules (fallback)
  const cwdPaths = [
    path.resolve(`node_modules/${pkgName}/bin/${OPENCODE_BINARY_NAME}`),
    path.resolve(`../node_modules/${pkgName}/bin/${OPENCODE_BINARY_NAME}`),
  ];
  for (const p of cwdPaths) {
    const normalized = normalizeWindowsPath(p);
    sidecarLog(`[resolveOpencodeBinary] Strategy 3 (CWD): ${normalized}, exists=${tryFile(normalized)}`);
    if (tryFile(normalized)) {
      return normalized;
    }
  }

  // Strategy 4: Tauri resource directory (production builds)
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    const resourcePaths = [
      path.join(resourceDir, OPENCODE_BINARY_NAME),
      path.join(resourceDir, 'resources', OPENCODE_BINARY_NAME),
    ];
    for (const p of resourcePaths) {
      const normalized = normalizeWindowsPath(p);
      sidecarLog(`[resolveOpencodeBinary] Strategy 4 (resources): ${normalized}, exists=${tryFile(normalized)}`);
      if (tryFile(normalized)) {
        return normalized;
      }
    }
  }

  sidecarLog('[resolveOpencodeBinary] No strategy succeeded, returning undefined');
  return undefined;
}
