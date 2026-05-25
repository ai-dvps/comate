import { createRequire } from 'module';
import path from 'path';
import { sidecarLog } from './sidecar-logger.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const CLAUDE_BINARY_NAME = process.platform === 'win32' ? 'claude.exe' : 'claude';

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
    const binaryPath = normalizeWindowsPath(path.join(path.dirname(resolved), CLAUDE_BINARY_NAME));
    sidecarLog(`[resolveSdkBinary] Strategy 1 (require.resolve): ${binaryPath}`);
    return binaryPath;
  }

  // Strategy 2: look next to the executable (pkg-bundled sidecar)
  const nextToExec = normalizeWindowsPath(path.join(path.dirname(process.execPath), CLAUDE_BINARY_NAME));
  sidecarLog(`[resolveSdkBinary] Strategy 2 (next to exec): ${nextToExec}, exists=${tryFile(nextToExec)}`);
  if (tryFile(nextToExec)) {
    return nextToExec;
  }

  // Strategy 3: look in CWD/node_modules and CWD/../node_modules (fallback)
  const cwdPaths = [
    path.resolve(`node_modules/@anthropic-ai/claude-agent-sdk-${PLATFORM_ARCH}/${CLAUDE_BINARY_NAME}`),
    path.resolve(`../node_modules/@anthropic-ai/claude-agent-sdk-${PLATFORM_ARCH}/${CLAUDE_BINARY_NAME}`),
  ];
  for (const p of cwdPaths) {
    const normalized = normalizeWindowsPath(p);
    sidecarLog(`[resolveSdkBinary] Strategy 3 (CWD): ${normalized}, exists=${tryFile(normalized)}`);
    if (tryFile(normalized)) {
      return normalized;
    }
  }

  // Strategy 4: Tauri resource directory (production builds)
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    const resourcePaths = [
      path.join(resourceDir, CLAUDE_BINARY_NAME),
      path.join(resourceDir, 'resources', CLAUDE_BINARY_NAME),
    ];
    for (const p of resourcePaths) {
      const normalized = normalizeWindowsPath(p);
      sidecarLog(`[resolveSdkBinary] Strategy 4 (resources): ${normalized}, exists=${tryFile(normalized)}`);
      if (tryFile(normalized)) {
        return normalized;
      }
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
