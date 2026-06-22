import { createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';
import util from 'util';
import { getLogsDir } from './log-cleanup.js';

const logFile = path.join(getLogsDir(), 'sse-diag.log');
const mirrorToConsole = process.env.COMATE_SIDECAR !== '1';

if (!existsSync(path.dirname(logFile))) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    // Ignore directory creation errors
  }
}

const stream = createWriteStream(logFile, { flags: 'a' });
stream.on('error', (err) => {
  if (mirrorToConsole) {
    console.error('[diag-logger] stream error:', err.message);
  }
});

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return String(arg);
  return util.inspect(arg, { depth: null, colors: false });
}

export function diagLog(...args: unknown[]): void {
  const line = `[${timestamp()}] ${args.map(formatArg).join(' ')}`;
  if (mirrorToConsole) {
    console.log(line);
  }
  if (stream.writable) {
    stream.write(line + '\n');
  }
}

export function diagWarn(...args: unknown[]): void {
  const line = `[${timestamp()}] [WARN] ${args.map(formatArg).join(' ')}`;
  if (mirrorToConsole) {
    console.warn(line);
  }
  if (stream.writable) {
    stream.write(line + '\n');
  }
}
