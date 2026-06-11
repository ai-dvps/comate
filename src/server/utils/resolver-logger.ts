import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import { getLogsDir } from './log-cleanup.js';

const logsDir = getLogsDir();
const logFile = path.join(logsDir, 'wecom-resolver.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATION_CHECK_INTERVAL = 100; // Check rotation every 100 writes

function ensureDir(): void {
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}

let currentLogFile = logFile;
let writeCount = 0;

function rotateIfNeeded(): void {
  writeCount++;
  if (writeCount % ROTATION_CHECK_INTERVAL !== 0) return;

  try {
    if (!existsSync(currentLogFile)) return;
    const stats = statSync(currentLogFile);
    if (stats.size > MAX_LOG_SIZE) {
      const rotated = `${logFile}.1`;
      if (existsSync(rotated)) {
        // Simple rotation: drop the old .1
      }
      renameSync(currentLogFile, rotated);
      // Recreate the write stream on the new file
      currentLogFile = logFile;
      stream = createWriteStream(currentLogFile, { flags: 'a' });
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

let stream = createWriteStream(currentLogFile, { flags: 'a' });

function write(level: string, ...args: unknown[]): void {
  ensureDir();
  rotateIfNeeded();
  const line = `[${timestamp()}] [${level}] ${args.map((a) => {
    if (typeof a === 'object' && a !== null) {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(' ')}`;
  if (stream.writable) {
    stream.write(line + '\n');
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
