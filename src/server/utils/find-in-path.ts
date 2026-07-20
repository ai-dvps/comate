import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

/**
 * Shared PATH lookup (`where` on Windows, `command -v` elsewhere). Returns the
 * first printed candidate that exists on disk, or undefined when the command
 * is not resolvable.
 */
export function findInPath(command: string): string | undefined {
  const cmd = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  const result = spawnSync(cmd, { encoding: 'utf-8', shell: true });
  const lines = result.stdout?.trim().split('\n') || [];
  for (const line of lines) {
    const p = line.trim();
    if (p && existsSync(p)) {
      return p;
    }
  }
  return undefined;
}
