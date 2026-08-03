import fs from 'node:fs';

/**
 * U12 (KTD-28): the CLI context is passed EXPLICITLY via the
 * COMATE_WECOM_CONTEXT_FILE environment variable (an absolute path to the
 * per-session context file in `data/<userDir>/.runtime/`). The legacy
 * upward-walk discovery for `.claude/wecom-context.json` is removed: a
 * context file planted in a user-writable directory can no longer redirect
 * the CLI at another workspace or server.
 */
export const CONTEXT_FILE_ENV = 'COMATE_WECOM_CONTEXT_FILE';

/** Env var carrying the per-session loopback capability token (Bearer). */
export const SESSION_TOKEN_ENV = 'COMATE_SESSION_TOKEN';

export interface ContextFile {
  workspaceId?: string;
  botId: string;
  serverUrl: string;
}

/**
 * Resolve the context file path from the environment. Returns null when the
 * variable is unset or empty (the CLI is being run outside a Comate bot
 * session).
 */
export function resolveContextFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[CONTEXT_FILE_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Resolve the session capability token from the environment. Returns null
 * when unset/empty.
 */
export function resolveSessionToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[SESSION_TOKEN_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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
