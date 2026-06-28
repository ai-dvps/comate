import type { BotProviderSettings } from '../models/bot.js';
import { ENCRYPTED_PROVIDER_KEYS } from '../models/bot.js';
import { decryptCredential, encryptCredential } from './credential-crypto.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encryptConfigValues(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ENCRYPTED_PROVIDER_KEYS.includes(key) && typeof value === 'string' && value.length > 0) {
      result[key] = encryptCredential(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function decryptConfigValues(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ENCRYPTED_PROVIDER_KEYS.includes(key) && typeof value === 'string' && value.length > 0) {
      result[key] = decryptCredential(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Encrypt sensitive credential fields inside provider settings before the
 * settings are serialized to the database.
 */
export function encryptProviderSettings(settings: BotProviderSettings): BotProviderSettings {
  const result: BotProviderSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = encryptConfigValues(settings.wecom) as BotProviderSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = encryptConfigValues(settings.feishu) as BotProviderSettings['feishu'];
  }
  return result;
}

/**
 * Decrypt sensitive credential fields after reading provider settings from the
 * database.
 */
export function decryptProviderSettings(settings: BotProviderSettings): BotProviderSettings {
  const result: BotProviderSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = decryptConfigValues(settings.wecom) as BotProviderSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = decryptConfigValues(settings.feishu) as BotProviderSettings['feishu'];
  }
  return result;
}
