import fs from 'node:fs';
import path from 'node:path';
import { copyFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { resolveWecomCliPath } from './resolve-wecom-cli.js';

function getTargetDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin');
  }
  return path.join(process.env.HOME || '', '.local', 'bin');
}

function getTargetPath(): string {
  const dir = getTargetDir();
  const name = process.platform === 'win32' ? 'wecom.exe' : 'wecom';
  return path.join(dir, name);
}

export interface InstallResult {
  installed: boolean;
  path?: string;
  error?: string;
}

export function checkWecomCliInstallation(): InstallResult {
  const target = getTargetPath();
  if (existsSync(target)) {
    return { installed: true, path: target };
  }
  return { installed: false };
}

export function installWecomCli(): InstallResult {
  const source = resolveWecomCliPath();
  if (!source) {
    return { installed: false, error: 'CLI not found in application bundle' };
  }

  const targetDir = getTargetDir();
  const target = getTargetPath();

  try {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, target);

    if (process.platform !== 'win32') {
      chmodSync(target, 0o755);
    }

    return { installed: true, path: target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

export function uninstallWecomCli(): InstallResult {
  const target = getTargetPath();
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { installed: true, path: target, error: message };
    }
  }
  return { installed: false };
}
