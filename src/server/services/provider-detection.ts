import { loadClaudeSettings } from '../utils/claude-settings.js';
import type { CreateProviderInput } from '../models/provider.js';

/**
 * Auto-detect existing Claude Code configuration from ~/.claude/settings.json
 * and process.env. Returns a CreateProviderInput if a valid auth token is found,
 * or null if detection fails or finds only partial config.
 */
export function detectProviderConfig(): CreateProviderInput | null {
  const settings = loadClaudeSettings();

  // Env vars take precedence over settings.json
  const env = process.env;
  const merged: Record<string, string> = { ...settings };

  const envVarsToCheck = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
  ];

  for (const key of envVarsToCheck) {
    const value = env[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Also pick up any other ANTHROPIC_* or CLAUDE_CODE_* env vars
  for (const [key, value] of Object.entries(env)) {
    if ((key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) && value !== undefined) {
      merged[key] = value;
    }
  }

  // A valid auth token is required
  const authToken = merged.ANTHROPIC_AUTH_TOKEN || merged.ANTHROPIC_API_KEY;
  if (!authToken || authToken.trim().length === 0) {
    return null;
  }

  // Base URL is required for a proxy provider; if missing, still create but
  // default to Anthropic's official endpoint so the provider is functional.
  const baseUrl = merged.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';

  const customEnvVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (
      !envVarsToCheck.includes(key) &&
      (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_'))
    ) {
      customEnvVars[key] = value;
    }
  }

  const result: CreateProviderInput = {
    name: 'Default',
    baseUrl,
    authToken,
    model: merged.ANTHROPIC_MODEL || undefined,
    isDefault: true,
    defaultOpusModel: merged.ANTHROPIC_DEFAULT_OPUS_MODEL || undefined,
    defaultSonnetModel: merged.ANTHROPIC_DEFAULT_SONNET_MODEL || undefined,
    defaultHaikuModel: merged.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined,
    subagentModel: merged.CLAUDE_CODE_SUBAGENT_MODEL || undefined,
    effortLevel: merged.CLAUDE_CODE_EFFORT_LEVEL || undefined,
    customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
  };

  return result;
}
