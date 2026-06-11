import { spawnSync } from 'node:child_process';
import { resolveWecomCliPackageDir } from './resolve-wecom-cli.js';

export interface InstallResult {
  installed: boolean;
  path?: string;
  error?: string;
}

export function checkWecomCliInstallation(): InstallResult {
  const result = spawnSync('wecom', ['--version'], { encoding: 'utf-8' });
  if (result.status === 0) {
    return { installed: true, path: 'wecom' };
  }
  return { installed: false };
}

export function installWecomCli(): InstallResult {
  const packageDir = resolveWecomCliPackageDir();
  if (!packageDir) {
    return { installed: false, error: 'CLI package not found in application bundle' };
  }

  try {
    const result = spawnSync('npm', ['install', '-g', packageDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      return {
        installed: false,
        error: result.stderr || `npm install exited with code ${result.status}`,
      };
    }

    return { installed: true, path: 'wecom' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

export function uninstallWecomCli(): InstallResult {
  const result = spawnSync('npm', ['uninstall', '-g', '@webank/wecom'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.status === 0) {
    return { installed: false };
  }
  return { installed: true, error: result.stderr || 'npm uninstall failed' };
}
