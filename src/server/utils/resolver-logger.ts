import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const dataDir = process.env.COMATE_DATA_DIR || getStorageDir();
const logsDir = path.join(dataDir, 'logs');
const logFile = path.join(logsDir, 'wecom-resolver.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

function ensureDir(): void {
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(logFile)) return;
    const stats = statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const rotated = `${logFile}.1`;
      if (existsSync(rotated)) {
        // Simple rotation: drop the old .1
        // In a production system you might want a chain (.1 → .2, etc.)
        // For diagnostic logging, one backup is enough.
      }
      renameSync(logFile, rotated);
    }
  } catch {
    // Ignore rotation errors; keep appending
  }
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function write(level: string, ...args: unknown[]): void {
  ensureDir();
  rotateIfNeeded();
  const line = `[${timestamp()}] [${level}] ${args.map(String).join(' ')}`;
  try {
    appendFileSync(logFile, line + '\n');
  } catch {
    // Silently ignore write failures to avoid disrupting resolver operations
  }
}

export function resolverLog(...args: unknown[]): void {
  write('INFO', ...args);
}

export function resolverWarn(...args: unknown[]): void {
  write('WARN', ...args);
}

export function resolverError(...args: unknown[]): void {
  write('ERROR', ...args);
}
