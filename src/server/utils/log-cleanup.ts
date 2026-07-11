import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const RETENTION_DAYS = 7;

/** Node archive shape: `<base>-<YYYY-MM-DD>.<N>.<ext>`. Active files and Rust
 *  timestamp archives do not match this and are left untouched (flexi_logger owns
 *  Rust archive retention via Cleanup::KeepForDays). */
const ARCHIVE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.\d+\.[^.]+$/;

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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function localDateString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Reclaim Node log archives older than 7 days, keyed on the date in the filename.
 *
 * - Only files matching `<base>-<YYYY-MM-DD>.<N>.<ext>` are candidates.
 * - Fixed-name active files (sse-diag.log, sidecar.log, wecom-resolver.log, main.log)
 *   never match and are never deleted.
 * - Rust timestamp archives never match; flexi_logger enforces their 7-day retention.
 * - The legacy 100 MB aggregate cap is gone: per-file rolling bounds size instead.
 */
export function runLogCleanup(now: Date = new Date()): void {
  try {
    const logsDir = getLogsDir();
    if (!existsSync(logsDir)) {
      return;
    }

    const cutoff = localDateString(
      new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );

    for (const name of readdirSync(logsDir)) {
      const m = name.match(ARCHIVE_RE);
      if (!m) {
        continue;
      }
      const date = m[2];
      if (date < cutoff) {
        try {
          unlinkSync(path.join(logsDir, name));
        } catch {
          // Ignore deletion errors
        }
      }
    }
  } catch {
    // Silently ignore all cleanup errors
  }
}
