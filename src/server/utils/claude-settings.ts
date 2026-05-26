import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { sidecarLog } from './sidecar-logger.js';

/**
 * Read the user's Claude Code settings.json and extract ANTHROPIC_* string values.
 * This ensures auth credentials are available when Claude Code is spawned from
 * the sidecar, where environment propagation may be incomplete (especially on
 * Windows with pkg-bundled binaries).
 */
export function loadClaudeSettings(): Record<string, string> {
  const home = homedir();
  const settingsPath = join(home, '.claude', 'settings.json');
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as Record<string, unknown>;
    const envSettings =
      settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
        ? (settings.env as Record<string, unknown>)
        : {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(envSettings)) {
      if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
        result[key] = value;
      }
    }
    sidecarLog(`[loadClaudeSettings] loaded from ${settingsPath}, keys=[${Object.keys(result).join(', ')}]`);
    return result;
  } catch {
    sidecarLog(`[loadClaudeSettings] no readable settings at ${settingsPath}`);
    return {};
  }
}
