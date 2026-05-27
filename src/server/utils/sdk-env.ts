import { loadClaudeSettings, resolveClaudeConfigDir } from './claude-settings.js';

export function buildClaudeEnv(
  claudeSettings: Record<string, string>,
): {
  env: Record<string, string | undefined>;
  sources: Record<string, 'process' | 'settings'>;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  const sources: Record<string, 'process' | 'settings'> = {};
  const claudeConfigDir = resolveClaudeConfigDir();
  if (!env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  }
  if (process.platform === 'win32' && !env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = claudeConfigDir;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') && env[key]) {
      sources[key] = 'process';
    }
  }
  for (const [key, value] of Object.entries(claudeSettings)) {
    if (!env[key]) {
      env[key] = value;
      sources[key] = 'settings';
    }
  }
  return { env, sources };
}

export function prependEnvPath(
  env: Record<string, string | undefined>,
  dir: string,
): void {
  const pathKey = getPathEnvKey(env);
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  env[pathKey] = dir + pathSeparator + (env[pathKey] || '');
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key !== pathKey && key.toLowerCase() === 'path') {
        delete env[key];
      }
    }
  }
}

export function getPathEnvKey(env: Record<string, string | undefined>): string {
  if (process.platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}
