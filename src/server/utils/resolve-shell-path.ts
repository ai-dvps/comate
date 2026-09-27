import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { sidecarLog } from './sidecar-logger.js';
import { initializeResolvedShellEnv, getResolvedShellEnv } from './resolve-shell-env.js';

interface ResolvedPath {
  path: string;
  source: 'shell' | 'fallback' | 'none';
  shellDirs: string[] | null;
  fallbackDirs: string[] | null;
}

function expandHome(dir: string): string {
  if (dir.startsWith('~/')) {
    return path.join(homedir(), dir.slice(2));
  }
  return dir;
}

function getFallbackDirectories(): string[] {
  const dirs: string[] = [];
  if (process.platform === 'darwin') {
    dirs.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      expandHome('~/.local/bin'),
    );
  } else if (process.platform === 'linux') {
    dirs.push(
      expandHome('~/.local/bin'),
      '/usr/local/bin',
      '/usr/local/sbin',
    );
  } else if (process.platform === 'win32') {
    if (process.env.USERPROFILE) {
      dirs.push(path.join(process.env.USERPROFILE, '.local', 'bin'));
    }
    if (process.env.APPDATA) {
      dirs.push(path.join(process.env.APPDATA, 'npm'));
    }
  }
  return dirs.filter((d) => existsSync(d));
}

function resolveFallbackPath(): ResolvedPath {
  if (process.platform === 'win32') {
    const basePath = process.env.PATH || '';
    const fallbackDirs = getFallbackDirectories();
    const existingDirs = basePath.split(';').map((d) => d.trim().toLowerCase());
    const newDirs = fallbackDirs.filter(
      (d) => !existingDirs.includes(d.trim().toLowerCase()),
    );
    if (newDirs.length > 0) {
      const enriched = newDirs.join(';') + (basePath ? ';' + basePath : '');
      sidecarLog(`[resolve-shell-path] Windows base PATH enriched with fallback dirs: ${newDirs.join('; ')}`);
      return { path: enriched, source: 'fallback', shellDirs: null, fallbackDirs: newDirs };
    }
    return { path: basePath, source: 'none', shellDirs: null, fallbackDirs: null };
  }

  const fallbackDirs = getFallbackDirectories();
  if (fallbackDirs.length > 0) {
    const fallbackPath = fallbackDirs.join(':');
    sidecarLog(`[resolve-shell-path] using fallback directories: ${fallbackDirs.join(': ')}`);
    return { path: fallbackPath, source: 'fallback', shellDirs: null, fallbackDirs };
  }

  sidecarLog('[resolve-shell-path] no shell capture or fallback directories available');
  return { path: '', source: 'none', shellDirs: null, fallbackDirs: null };
}

export async function initializeResolvedShellPath(): Promise<void> {
  await initializeResolvedShellEnv();
}

export function getResolvedShellPath(): ResolvedPath {
  const shellEnv = getResolvedShellEnv();

  if (shellEnv) {
    const shellPath = shellEnv.PATH || '';
    const shellDirs = shellPath.split(':').filter((d) => d.trim().length > 0);
    return { path: shellPath, source: 'shell', shellDirs, fallbackDirs: null };
  }

  // Synchronous fallback when shell env is unavailable (Windows, or capture failed)
  return resolveFallbackPath();
}
