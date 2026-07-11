import util from 'util';
import { RotatingWriter } from './rotating-writer.js';

const mirrorToConsole = () => process.env.COMATE_SIDECAR !== '1';

const writer = new RotatingWriter({
  name: 'sse-diag.log',
  onError: (err) => {
    if (mirrorToConsole()) {
      console.error('[diag-logger] stream error:', err.message);
    }
  },
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
  if (mirrorToConsole()) {
    console.log(line);
  }
  writer.write(line);
}

export function diagWarn(...args: unknown[]): void {
  const line = `[${timestamp()}] [WARN] ${args.map(formatArg).join(' ')}`;
  if (mirrorToConsole()) {
    console.warn(line);
  }
  writer.write(line);
}
