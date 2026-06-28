import type { BotActor } from './bot-service.js';
import type { BotProvider } from '../models/bot.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

export type BotAuditEventType =
  | 'bot_created'
  | 'bot_deleted'
  | 'provider_credentials_changed'
  | 'provider_enabled'
  | 'provider_disabled'
  | 'active_workspace_switched'
  | 'member_added'
  | 'member_removed'
  | 'member_role_changed'
  | 'file_access_denied';

/**
 * Sanitize audit details so sensitive values are never persisted or logged.
 * Any nested strings that look like credential material are replaced with
 * `<set>` markers; the structure is otherwise preserved.
 */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' && value.length > 32) {
      // Heuristic: long strings are likely secrets or ciphertext; redact them.
      sanitized[key] = '<redacted>';
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? sanitizeDetails(item as Record<string, unknown>)
          : typeof item === 'string' && item.length > 32
            ? '<redacted>'
            : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeDetails(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class BotAuditLogger {
  private store: SqliteStore;

  constructor(store?: SqliteStore) {
    this.store = store ?? defaultStore;
  }

  log(
    botId: string,
    actor: BotActor,
    eventType: BotAuditEventType,
    details: Record<string, unknown> = {},
  ): void {
    try {
      const safeDetails = sanitizeDetails(details);
      this.store.recordAuditLog({
        botId,
        actorType: actor.type,
        actorId: actor.providerUserId ?? 'system',
        eventType,
        details: safeDetails,
      });
      diagLog(`[BotAudit] ${eventType}`, { botId, actorType: actor.type, actorId: actor.providerUserId, ...safeDetails });
    } catch (err) {
      diagLog('Failed to record bot audit log', { botId, eventType, error: String(err) });
    }
  }

  logProviderCredentialsChanged(
    botId: string,
    actor: BotActor,
    providers: string[],
  ): void {
    this.log(botId, actor, 'provider_credentials_changed', { providers });
  }

  logProviderEnabled(
    botId: string,
    actor: BotActor,
    provider: BotProvider,
  ): void {
    this.log(botId, actor, 'provider_enabled', { provider });
  }

  logProviderDisabled(
    botId: string,
    actor: BotActor,
    provider: BotProvider,
  ): void {
    this.log(botId, actor, 'provider_disabled', { provider });
  }

  logActiveWorkspaceSwitched(
    botId: string,
    actor: BotActor,
    previousWorkspaceId: string | null,
    newWorkspaceId: string,
  ): void {
    this.log(botId, actor, 'active_workspace_switched', {
      previousWorkspaceId,
      newWorkspaceId,
    });
  }

  logMemberRoleChanged(
    botId: string,
    actor: BotActor,
    provider: BotProvider,
    providerUserId: string,
    previousRole: string | null,
    newRole: string,
  ): void {
    this.log(botId, actor, 'member_role_changed', {
      provider,
      providerUserId,
      previousRole,
      newRole,
    });
  }

  logFileAccessDenied(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      toolName: string;
      reason: string;
      path?: string;
    },
  ): void {
    this.log(botId, actor, 'file_access_denied', details);
  }
}

export const botAuditLogger = new BotAuditLogger();
