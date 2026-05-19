import { createRequire } from 'module';
import path from 'path';
import { sidecarLog } from './sidecar-logger.js';

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;

function tryResolve(packageName: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(packageName);
  } catch (err) {
    sidecarLog(`[resolveSdkBinary] Strategy 1 error resolving ${packageName}: ${err}`);
    return undefined;
  }
}

/**
 * Resolve the path to the Claude Code CLI binary bundled with the SDK's
 * optional dependency. This ensures version compatibility between the SDK
 * and the CLI (the optional dep is version-locked to the SDK).
 *
 * Tries multiple resolution strategies to work in both dev mode (tsx from
 * source tree) and in the pkg-bundled sidecar binary.
 */
export function resolveSdkBinary(): string | undefined {
  // Strategy 1: resolve via require from the source tree (dev mode)
  const pkgName = `@anthropic-ai/claude-agent-sdk-${PLATFORM_ARCH}`;
  let resolved = tryResolve(`${pkgName}/package.json`);

  if (!resolved && process.platform === 'linux') {
    resolved = tryResolve(`${pkgName}-musl/package.json`);
  }

  if (resolved) {
    const binaryPath = path.join(path.dirname(resolved), 'claude');
    sidecarLog(`[resolveSdkBinary] Strategy 1 (require.resolve): ${binaryPath}`);
    return binaryPath;
  }

  // Strategy 2: look next to the executable (pkg-bundled sidecar)
  const nextToExec = path.join(path.dirname(process.execPath), 'claude');
  sidecarLog(`[resolveSdkBinary] Strategy 2 (next to exec): ${nextToExec}, exists=${tryFile(nextToExec)}`);
  if (tryFile(nextToExec)) {
    return nextToExec;
  }

  // Strategy 3: look in CWD/node_modules and CWD/../node_modules (fallback)
  const cwdPaths = [
    path.resolve(`node_modules/@anthropic-ai/claude-agent-sdk-${PLATFORM_ARCH}/claude`),
    path.resolve(`../node_modules/@anthropic-ai/claude-agent-sdk-${PLATFORM_ARCH}/claude`),
  ];
  for (const p of cwdPaths) {
    sidecarLog(`[resolveSdkBinary] Strategy 3 (CWD): ${p}, exists=${tryFile(p)}`);
    if (tryFile(p)) {
      return p;
    }
  }

  // Strategy 4: Tauri resource directory (production builds)
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    const fromResources = path.join(resourceDir, 'claude');
    sidecarLog(`[resolveSdkBinary] Strategy 4 (resources): ${fromResources}, exists=${tryFile(fromResources)}`);
    if (tryFile(fromResources)) {
      return fromResources;
    }
  }

  sidecarLog(`[resolveSdkBinary] No strategy succeeded, returning undefined`);
  return undefined;
}

function tryFile(filePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('fs');
    return existsSync(filePath);
  } catch {
    return false;
  }
}
