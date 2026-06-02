import { existsSync } from 'fs';
import { resolveClaudeConfigDir } from './claude-settings.js';
import { getResolvedShellPath } from './resolve-shell-path.js';
import { getResolvedShellEnv } from './resolve-shell-env.js';
import { loadCustomPaths } from './path-config.js';
import { sidecarLog } from './sidecar-logger.js';

export function buildClaudeEnv(
  claudeSettings: Record<string, string>,
): {
  env: Record<string, string | undefined>;
  sources: Record<string, 'process' | 'settings'>;
} {
  const shellEnv = getResolvedShellEnv();
  const env: Record<string, string | undefined> = shellEnv ? { ...shellEnv } : { ...process.env };
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

  // Enrich PATH
  const enrichedPath = buildEnrichedPath(env);
  const pathKey = getPathEnvKey(env);
  env[pathKey] = enrichedPath;

  return { env, sources };
}

function buildEnrichedPath(
  env: Record<string, string | undefined>,
): string {
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const basePath = env[getPathEnvKey(env)] || '';

  const resolved = getResolvedShellPath();
  const customPaths = loadCustomPaths().filter((p) => existsSync(p));

  const parts: string[] = [];
  const seen = new Set<string>();

  function addPart(part: string) {
    const normalized = process.platform === 'win32' ? part.trim().toLowerCase() : part.trim();
    if (normalized.length === 0) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(part.trim());
  }

  // 1. Custom paths first (highest precedence among what buildClaudeEnv controls)
  for (const dir of customPaths) {
    addPart(dir);
  }

  // 2. Shell-captured or fallback directories
  if (resolved.path) {
    for (const dir of resolved.path.split(pathSeparator)) {
      addPart(dir);
    }
  }

  // 3. Base process.env.PATH
  for (const dir of basePath.split(pathSeparator)) {
    addPart(dir);
  }

  const result = parts.join(pathSeparator);

  const pathSources: string[] = [];
  if (customPaths.length > 0) pathSources.push('custom');
  if (resolved.source === 'shell') pathSources.push('shell');
  if (resolved.source === 'fallback') pathSources.push('fallback');
  pathSources.push('base');
  sidecarLog(`[buildClaudeEnv] enriched PATH sources=[${pathSources.join(',')}], length=${result.length}`);

  return result;
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
