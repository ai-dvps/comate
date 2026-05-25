import { join, dirname } from 'path';
import { existsSync } from 'fs';

export function getNativeBindingPath(): string | undefined {
  if (!process.env.COMATE_SIDECAR) {
    return undefined;
  }

  const execDir = dirname(process.execPath);

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
