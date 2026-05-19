import { appendFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const dataDir = process.env.CLAUDE_CODE_GUI_DATA_DIR;
const logFile = dataDir ? path.join(dataDir, 'sidecar.log') : null;

if (logFile && !existsSync(path.dirname(logFile))) {
  mkdirSync(path.dirname(logFile), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

export function sidecarLog(...args: unknown[]): void {
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

export function sidecarError(...args: unknown[]): void {
  const line = `[${timestamp()}] [ERROR] ${args.map(String).join(' ')}`;
  console.error(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}
