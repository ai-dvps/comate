import { join, dirname } from 'path';
import { existsSync } from 'fs';

/** Strip Windows extended-length path prefix so paths work with spawn/exec. */
function normalizeWindowsPath(p: string): string {
  if (process.platform === 'win32' && p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}

export function getNativeBindingPath(): string | undefined {
  if (!process.env.COMATE_SIDECAR) {
    return undefined;
  }

  const execDir = dirname(normalizeWindowsPath(process.execPath));

  const candidates = [
    // macOS app bundle
    join(execDir, '..', 'Resources', 'resources', 'better_sqlite3.node'),
    join(execDir, 'resources', 'better_sqlite3.node'),
    // Windows / Linux (resources next to executable)
    join(execDir, '..', 'resources', 'better_sqlite3.node'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}
