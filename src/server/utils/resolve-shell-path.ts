import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { sidecarLog } from './sidecar-logger.js';

const TIMEOUT_MS = 5000;

interface ResolvedPath {
  path: string;
  source: 'shell' | 'fallback' | 'none';
  shellDirs: string[] | null;
  fallbackDirs: string[] | null;
}

let cached: ResolvedPath | null = null;

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

function getDefaultShell(): string | null {
  const shell = process.env.SHELL;
  if (shell) return shell;
  return null;
}

async function spawnShellForPath(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: string | null) => {
      if (settled) return false;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
      return true;
    };

    try {
      const proc = spawn(shell, ['-lc', 'echo "$PATH"'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      proc.stderr?.on('data', (d) => {
        stderr += String(d);
      });

      proc.on('close', (code) => {
        if (!finish(null)) return;
        if (code !== 0) {
          sidecarLog(`[resolve-shell-path] shell ${shell} exited with code ${code}, stderr: ${stderr.trim()}`);
          resolve(null);
          return;
        }
        const parsed = stdout.trim().split('\n').pop()?.trim() ?? '';
        if (parsed) {
          resolve(parsed);
        } else {
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        if (!finish(null)) return;
        sidecarLog(`[resolve-shell-path] failed to spawn ${shell}: ${err.message}`);
        resolve(null);
      });

      timeout = setTimeout(() => {
        if (!finish(null)) return;
        sidecarLog(`[resolve-shell-path] shell ${shell} timed out after ${TIMEOUT_MS}ms`);
        proc.kill('SIGKILL');
        resolve(null);
      }, TIMEOUT_MS);
    } catch (err) {
      if (!finish(null)) return;
      sidecarLog(`[resolve-shell-path] exception spawning ${shell}: ${err}`);
      resolve(null);
    }
  });
}

async function resolveShellPath(): Promise<ResolvedPath> {
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

  // macOS / Linux
  const shellsToTry: string[] = [];
  const defaultShell = getDefaultShell();
  if (defaultShell) shellsToTry.push(defaultShell);
  shellsToTry.push('/bin/zsh', '/bin/bash', '/bin/sh');

  for (const shell of shellsToTry) {
    if (!existsSync(shell)) continue;
    const result = await spawnShellForPath(shell);
    if (result) {
      sidecarLog(`[resolve-shell-path] captured PATH from ${shell}`);
      const shellDirs = result.split(':').filter((d) => d.trim().length > 0);
      return { path: result, source: 'shell', shellDirs, fallbackDirs: null };
    }
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
  if (cached) return;
  cached = await resolveShellPath();
  sidecarLog(`[resolve-shell-path] resolved (source=${cached.source}): ${cached.path}`);
}

export function getResolvedShellPath(): ResolvedPath {
  if (!cached) {
    // Synchronous fallback for safety; should not happen if initialize was called
    return { path: '', source: 'none', shellDirs: null, fallbackDirs: null };
  }
  return cached;
}
