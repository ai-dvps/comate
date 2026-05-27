import { appendFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { ensureLogsDir, getLogsDir } from './log-cleanup.js';

const logFile = path.join(getLogsDir(), 'sidecar.log');

if (!existsSync(path.dirname(logFile))) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    // Ignore directory creation errors
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function sidecarLog(...args: unknown[]): void {
  const line = `[${timestamp()}] ${args.map(String).join(' ')}`;
  console.log(line);
  if (logFile) {
    try {
      ensureLogsDir();
      appendFileSync(logFile, line + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}

export function sidecarError(...args: unknown[]): void {
  const line = `[${timestamp()}] [ERROR] ${args.map(String).join(' ')}`;
  console.error(line);
  if (logFile) {
    try {
      ensureLogsDir();
      appendFileSync(logFile, line + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}
