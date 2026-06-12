/**
 * Git clone wrapper for the Skills adapter.
 *
 * Reimplemented rather than imported from upstream because upstream uses
 * `simple-git` (a Comate dependency we deliberately do not pull in for
 * skills). Instead we mirror the spawn-based git clone already used by
 * `src/server/utils/plugin-downloader.ts:364-409`, which uses Node's
 * built-in `child_process.spawn` and matches Comate's existing timeout
 * and stdio-collection conventions.
 */

import { spawn } from 'child_process';
import { sidecarLog } from '../../utils/sidecar-logger.js';

const DEFAULT_CLONE_TIMEOUT_MS = 60_000;

export interface GitCloneOptions {
  /** Branch or tag to clone (passed via `--branch`). When omitted, default branch. */
  ref?: string;
  /** Timeout in milliseconds. Defaults to 60s. */
  timeoutMs?: number;
}

export interface GitCloneResult {
  success: boolean;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  error?: string;
}

/**
 * Clone a git repository to `targetPath`. Uses `--depth 1` for speed;
 * the Skills page never needs history (it tracks commit via the lock file's
 * `skillFolderHash` instead).
 *
 * Behaves like `PluginDownloader.runGitClone` from
 * `src/server/utils/plugin-downloader.ts:364-409`: spawn, collect stdio,
 * enforce timeout, return structured result.
 */
export function cloneRepository(
  gitUrl: string,
  targetPath: string,
  options: GitCloneOptions = {}
): Promise<GitCloneResult> {
  const { ref, timeoutMs = DEFAULT_CLONE_TIMEOUT_MS } = options;

  const args = ['clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push(gitUrl, targetPath);

  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      sidecarLog(`[SkillsGitAdapter] clone timed out after ${timeoutMs}ms: ${gitUrl}`);
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        error: `Git clone timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const success = code === 0;
      if (!success) {
        sidecarLog(
          `[SkillsGitAdapter] clone failed (exit ${code}) for ${gitUrl}: ${(stderr || stdout).slice(0, 300)}`
        );
      }
      resolve({
        success,
        exitCode: code,
        stdout,
        stderr,
        error: success ? undefined : `Git clone failed (exit ${code}): ${stderr || stdout}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      sidecarLog(`[SkillsGitAdapter] spawn error for ${gitUrl}: ${err.message}`);
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        error: err.message,
      });
    });
  });
}
