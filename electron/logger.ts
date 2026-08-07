/**
 * U1: shell logger — the Electron equivalent of the Tauri shell's
 * flexi_logger setup (lib.rs:328-358). Writes `main.log` into
 * `<COMATE_DATA_DIR>/logs/`, the same folder the Node sidecar logs to, in
 * both debug and release builds.
 *
 * Rotation mirrors the Rust side's strategy with a deliberately small writer:
 * on startup, if the live file exceeds the size cap (100 MB, matching the
 * Node RotatingWriter threshold) it is renamed to a timestamped
 * `main.<YYYYMMDD-HHMMSS>.log` archive, and archives older than 7 days are
 * pruned. The Rust side also rolled at local midnight; this writer rolls on
 * size at startup only — noted as an accepted simplification for the shell
 * skeleton.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export interface ShellLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Absolute path of the live log file, or null when file logging failed. */
  readonly filePath: string | null;
}

export interface ShellLoggerOptions {
  /** Mirror records to stdout/stderr (dev parity with Duplicate::All). */
  mirrorToConsole?: boolean;
  /** Rotation size cap. Default 100 MB; injectable for tests. */
  maxSizeBytes?: number;
  /** Archive retention. Default 7 days; injectable for tests. */
  keepDays?: number;
  now?: () => number;
}

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_KEEP_DAYS = 7;
const ARCHIVE_PATTERN = /^main\..+\.log$/;

function formatTimestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function createShellLogger(logsDir: string, options: ShellLoggerOptions = {}): ShellLogger {
  const mirror = options.mirrorToConsole ?? true;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
  const now = options.now ?? Date.now;

  let filePath: string | null = null;

  try {
    mkdirSync(logsDir, { recursive: true });

    // Prune archives past the retention window.
    const cutoff = now() - keepDays * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(logsDir)) {
      if (!ARCHIVE_PATTERN.test(entry)) continue;
      const full = join(logsDir, entry);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // best-effort pruning
      }
    }

    // Rotate an oversized live file before appending further.
    const live = join(logsDir, 'main.log');
    if (existsSync(live) && statSync(live).size > maxSizeBytes) {
      renameSync(live, join(logsDir, `main.${formatTimestamp(new Date(now()))}.log`));
    }
    filePath = live;
  } catch (err) {
    // No usable logs directory: fall back to console-only (lib.rs:353-356).
    console.error(`[electron-shell] file logging unavailable: ${String(err)}`);
  }

  const write = (level: string, message: string): void => {
    const line = `[${new Date(now()).toISOString()}] [${level}] ${message}\n`;
    if (filePath) {
      try {
        appendFileSync(filePath, line);
      } catch {
        // A failing log sink must never take the shell down.
      }
    }
    if (mirror || !filePath) {
      if (level === 'ERROR') console.error(`[electron-shell] ${message}`);
      else console.log(`[electron-shell] [${level}] ${message}`);
    }
  };

  return {
    get filePath() {
      return filePath;
    },
    debug: (message) => write('DEBUG', message),
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}
