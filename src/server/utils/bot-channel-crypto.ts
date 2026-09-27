import type { BotChannelSettings } from '../models/bot.js';
import { ENCRYPTED_CHANNEL_KEYS } from '../models/bot.js';
import { decryptCredential, encryptCredential } from './credential-crypto.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encryptConfigValues(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (ENCRYPTED_CHANNEL_KEYS.includes(key) && typeof value === 'string' && value.length > 0) {
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
    if (ENCRYPTED_CHANNEL_KEYS.includes(key) && typeof value === 'string' && value.length > 0) {
      result[key] = decryptCredential(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Encrypt sensitive credential fields inside channel settings before the
 * settings are serialized to the database.
 */
export function encryptChannelSettings(settings: BotChannelSettings): BotChannelSettings {
  const result: BotChannelSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = encryptConfigValues(settings.wecom) as BotChannelSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = encryptConfigValues(settings.feishu) as BotChannelSettings['feishu'];
  }
  return result;
}

/**
 * Decrypt sensitive credential fields after reading channel settings from the
 * database.
 */
export function decryptChannelSettings(settings: BotChannelSettings): BotChannelSettings {
  const result: BotChannelSettings = {};
  if (isPlainObject(settings.wecom)) {
    result.wecom = decryptConfigValues(settings.wecom) as BotChannelSettings['wecom'];
  }
  if (isPlainObject(settings.feishu)) {
    result.feishu = decryptConfigValues(settings.feishu) as BotChannelSettings['feishu'];
  }
  return result;
}
