import { RotatingWriter } from './rotating-writer.js';

const writer = new RotatingWriter({
  name: 'wecom-resolver.log',
  onError: (err) => {
    console.error('[resolver-logger] stream error:', err.message);
  },
});

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function write(level: string, ...args: unknown[]): void {
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
  writer.write(line);
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
