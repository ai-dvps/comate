import { RotatingWriter } from './rotating-writer.js';

const mirrorToConsole = process.env.COMATE_SIDECAR !== '1';

const writer = new RotatingWriter({
  name: 'sidecar.log',
  onError: (err) => {
    if (mirrorToConsole) {
      console.error('[sidecar-logger] stream error:', err.message);
    }
  },
});

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

export function sidecarLog(...args: unknown[]): void {
  const line = `[${timestamp()}] ${args.map(String).join(' ')}`;
  if (mirrorToConsole) {
    console.log(line);
  }
  writer.write(line);
}

export function sidecarError(...args: unknown[]): void {
  const line = `[${timestamp()}] [ERROR] ${args.map(String).join(' ')}`;
  if (mirrorToConsole) {
    console.error(line);
  }
  writer.write(line);
}
