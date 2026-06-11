import { createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { getLogsDir } from './log-cleanup.js';

const logFile = path.join(getLogsDir(), 'sse-diag.log');

if (!existsSync(path.dirname(logFile))) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    // Ignore directory creation errors
  }
}

const stream = createWriteStream(logFile, { flags: 'a' });
stream.on('error', (err) => {
  console.error('[diag-logger] stream error:', err.message);
});

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

export function diagLog(...args: unknown[]): void {
  const line = `[${timestamp()}] ${args.map(String).join(' ')}`;
  console.log(line);
  if (stream.writable) {
    stream.write(line + '\n');
  }
}

export function diagWarn(...args: unknown[]): void {
  const line = `[${timestamp()}] [WARN] ${args.map(String).join(' ')}`;
  console.warn(line);
  if (stream.writable) {
    stream.write(line + '\n');
  }
}
