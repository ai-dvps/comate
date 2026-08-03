import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInPath } from './find-in-path.js';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { sidecarLog } from './sidecar-logger.js';

function existing(candidate: string): string | undefined {
  const normalized = normalizeWindowsPath(candidate);
  return existsSync(normalized) ? normalized : undefined;
}

export function resolveComateCliPath(): string | undefined {
  const resourceDir = process.env.TAURI_RESOURCE_DIR;
  if (resourceDir) {
    const triple = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
      : process.platform === 'win32'
        ? 'x86_64-pc-windows-msvc'
        : (process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu');
    const packaged = existing(path.join(
      resourceDir,
      'comate-cli',
      triple,
      process.platform === 'win32' ? 'comate.exe' : 'comate',
    ));
    if (packaged) return packaged;
  }

  const fromPath = findInPath('comate');
  if (fromPath) return fromPath;

  try {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), '../../..');
    // npm workspaces creates this executable shim/symlink. Returning the
    // dist entrypoint itself would make COMATE_CLI_PATH usable but would not
    // actually place a command named `comate` on the injected PATH.
    const workspaceCommand = existing(path.join(
      projectRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'comate.cmd' : 'comate',
    ));
    if (workspaceCommand) return workspaceCommand;
  } catch (error) {
    sidecarLog(`[resolveComateCliPath] module-relative resolution failed: ${error}`);
  }

  sidecarLog('[resolveComateCliPath] no packaged, PATH, or source-tree CLI found');
  return undefined;
}
