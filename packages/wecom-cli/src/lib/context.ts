import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_FILE_NAME = '.claude/wecom-context.json';

export interface ContextFile {
  workspaceId?: string;
  botId: string;
  serverUrl: string;
}

export function findContextFile(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const filePath = path.join(current, CONTEXT_FILE_NAME);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function readContextFile(filePath: string): ContextFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as unknown;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('botId' in data) ||
    !('serverUrl' in data) ||
    typeof (data as Record<string, unknown>).botId !== 'string' ||
    typeof (data as Record<string, unknown>).serverUrl !== 'string'
  ) {
    throw new Error('Invalid context file format: missing botId or serverUrl');
  }
  return data as ContextFile;
}
