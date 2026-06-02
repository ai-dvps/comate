import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { sidecarLog } from './sidecar-logger.js';

const TIMEOUT_MS = 5000;

let cachedEnv: Record<string, string> | null | undefined = undefined;
let _spawn: typeof spawn = spawn;

function getDefaultShell(): string | null {
  const shell = process.env.SHELL;
  if (shell) return shell;
  return null;
}

function parseEnvOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  // env -0 outputs null-delimited entries; on some systems the final entry
  // may not have a trailing null byte, so we also split on newline as a
  // safety net for mixed output.
  const entries = stdout.split('\0').filter((entry) => entry.trim().length > 0);
  for (const entry of entries) {
    const idx = entry.indexOf('=');
    if (idx === -1) continue;
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }
  return result;
}

async function spawnShellForEnv(shell: string): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) return false;
      settled = true;
      if (timeout) clearTimeout(timeout);
      return true;
    };

    try {
      const proc = _spawn(shell, ['-ilc', 'env -0'], {
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
        if (!finish()) return;
        if (code !== 0) {
          sidecarLog(`[resolve-shell-env] shell ${shell} exited with code ${code}, stderr: ${stderr.trim()}`);
          resolve(null);
          return;
        }
        const parsed = parseEnvOutput(stdout);
        sidecarLog(`[resolve-shell-env] captured ${Object.keys(parsed).length} vars from ${shell}`);
        resolve(parsed);
      });

      proc.on('error', (err) => {
        if (!finish()) return;
        sidecarLog(`[resolve-shell-env] failed to spawn ${shell}: ${err.message}`);
        resolve(null);
      });

      timeout = setTimeout(() => {
        if (!finish()) return;
        sidecarLog(`[resolve-shell-env] shell ${shell} timed out after ${TIMEOUT_MS}ms`);
        proc.kill('SIGKILL');
        resolve(null);
      }, TIMEOUT_MS);
    } catch (err) {
      if (!finish()) return;
      sidecarLog(`[resolve-shell-env] exception spawning ${shell}: ${err}`);
      resolve(null);
    }
  });
}

async function resolveShellEnv(): Promise<Record<string, string> | null> {
  if (process.platform === 'win32') {
    sidecarLog('[resolve-shell-env] skipping shell env capture on Windows');
    return null;
  }

  const shellsToTry: string[] = [];
  const defaultShell = getDefaultShell();
  if (defaultShell) shellsToTry.push(defaultShell);
  shellsToTry.push('/bin/zsh', '/bin/bash', '/bin/sh');

  for (const shell of shellsToTry) {
    if (!existsSync(shell)) continue;
    const result = await spawnShellForEnv(shell);
    if (result !== null) {
      return result;
    }
  }

  sidecarLog('[resolve-shell-env] no shell capture succeeded');
  return null;
}

export async function initializeResolvedShellEnv(): Promise<void> {
  if (cachedEnv !== undefined) return;
  cachedEnv = await resolveShellEnv();
  if (cachedEnv) {
    sidecarLog(`[resolve-shell-env] resolved ${Object.keys(cachedEnv).length} variables`);
  } else {
    sidecarLog('[resolve-shell-env] using fallback (process.env)');
  }
}

export function getResolvedShellEnv(): Record<string, string> | null {
  if (cachedEnv === undefined) {
    // Synchronous fallback for safety; should not happen if initialize was called
    return null;
  }
  return cachedEnv;
}

/** Reset the internal cache. Exposed only for tests. */
export function __resetCache(): void {
  cachedEnv = undefined;
}

/** Override spawn for testing. Exposed only for tests. */
export function __setSpawnForTesting(spawnImpl: typeof spawn): void {
  _spawn = spawnImpl;
}

/** Restore default spawn. Exposed only for tests. */
export function __restoreSpawn(): void {
  _spawn = spawn;
}
