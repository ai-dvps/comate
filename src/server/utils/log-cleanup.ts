import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export function getLogsDir(): string {
  return path.join(getStorageDir(), 'logs');
}

export function ensureLogsDir(): void {
  const logsDir = getLogsDir();
  if (!existsSync(logsDir)) {
    try {
      mkdirSync(logsDir, { recursive: true });
    } catch {
      // Ignore directory creation errors
    }
  }
}

interface LogFile {
  name: string;
  fullPath: string;
  mtime: number;
  size: number;
}

export function runLogCleanup(): void {
  try {
    const logsDir = getLogsDir();
    if (!existsSync(logsDir)) {
      return;
    }

    const entries = readdirSync(logsDir);
    const now = Date.now();
    const files: LogFile[] = [];

    for (const name of entries) {
      const fullPath = path.join(logsDir, name);
      try {
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
          continue;
        }
        files.push({
          name,
          fullPath,
          mtime: stats.mtime.getTime(),
          size: stats.size,
        });
      } catch {
        // Skip entries we can't stat
        continue;
      }
    }

    // Phase 1: delete files older than 7 days
    for (const file of files) {
      if (now - file.mtime > MAX_AGE_MS) {
        try {
          unlinkSync(file.fullPath);
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Phase 2: enforce size cap (delete oldest first)
    const remainingFiles = files
      .filter((f) => {
        try {
          return existsSync(f.fullPath);
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.mtime - b.mtime);

    let totalSize = remainingFiles.reduce((sum, f) => sum + f.size, 0);

    for (const file of remainingFiles) {
      if (totalSize <= MAX_SIZE_BYTES) {
        break;
      }
      try {
        unlinkSync(file.fullPath);
        totalSize -= file.size;
      } catch {
        // Ignore deletion errors
      }
    }
  } catch {
    // Silently ignore all cleanup errors
  }
}
