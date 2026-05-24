import { appendFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const dataDir = process.env.COMATE_DATA_DIR || getStorageDir();
const logFile = path.join(dataDir, 'sse-diag.log');

if (logFile && !existsSync(path.dirname(logFile))) {
  mkdirSync(path.dirname(logFile), { recursive: true });
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

export function diagLog(...args: unknown[]): void {
  const line = `[${timestamp()}] ${args.map(String).join(' ')}`;
  console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}

export function diagWarn(...args: unknown[]): void {
  const line = `[${timestamp()}] [WARN] ${args.map(String).join(' ')}`;
  console.warn(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}
