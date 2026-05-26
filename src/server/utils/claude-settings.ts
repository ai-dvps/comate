import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { sidecarLog } from './sidecar-logger.js';

/**
 * Read the user's Claude Code settings.json and extract ANTHROPIC_* string values.
 * This ensures auth credentials are available when Claude Code is spawned from
 * the sidecar, where environment propagation may be incomplete (especially on
 * Windows with pkg-bundled binaries).
 */
export function loadClaudeSettings(): Record<string, string> {
  const { settingsPath, homeCandidates } = resolveClaudeSettingsPath();

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as Record<string, unknown>;
    const envSettings = getObject(settings.env);
    const result: Record<string, string> = {};

    copyAnthropicValues(settings, result);
    copyAnthropicValues(envSettings, result);

    sidecarLog(`[loadClaudeSettings] loaded from ${settingsPath}, keys=[${Object.keys(result).join(', ')}]`);
    return result;
  } catch {
    sidecarLog(`[loadClaudeSettings] no readable settings at ${settingsPath}, homeCandidates=[${homeCandidates.join(', ')}]`);
    return {};
  }
}

export function resolveClaudeConfigDir(): string {
  return dirname(resolveClaudeSettingsPath().settingsPath);
}

function resolveClaudeSettingsPath(): {
  settingsPath: string;
  homeCandidates: string[];
} {
  const homeCandidates = getHomeCandidates();
  const settingsPath = homeCandidates
    .map((home) => join(home, '.claude', 'settings.json'))
    .find((candidate) => existsSync(candidate))
    ?? join(homeCandidates[0] ?? homedir(), '.claude', 'settings.json');
  return { settingsPath, homeCandidates };
}

function getHomeCandidates(): string[] {
  const candidates = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined,
    homedir(),
  ];
  return [...new Set(candidates.filter((value): value is string => !!value))];
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function copyAnthropicValues(
  source: Record<string, unknown>,
  target: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
      target[key] = value;
    }
  }
}
