import { createHash } from 'node:crypto';
import type { BotActor } from './bot-service.js';
import type { BotChannelKey } from '../models/bot.js';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

export type BotAuditEventType =
  | 'bot_created'
  | 'bot_deleted'
  | 'channel_credentials_changed'
  | 'channel_credentials_viewed'
  | 'channel_enabled'
  | 'channel_disabled'
  | 'channel_reconnect_requested'
  | 'channel_reconnect_succeeded'
  | 'channel_reconnect_failed'
  | 'active_workspace_switched'
  | 'user_added'
  | 'user_removed'
  | 'user_role_changed'
  | 'file_access_denied'
  // U6 (KTD-22): permission-sandbox decision audit.
  | 'bash_denied'
  | 'sandbox_escape_requested'
  | 'sandbox_escape_approved'
  | 'sandbox_escape_denied'
  | 'sandbox_escape_expired'
  | 'passlist_rule_added'
  | 'capability_dir_write'
  // U6 (KTD-22 + U12 notes): loopback capability-token lifecycle.
  | 'capability_token_minted'
  | 'capability_token_revoked'
  | 'loopback_auth_rejected';

/**
 * Sentinel bot bucket for loopback rejections that cannot be attributed to a
 * bot (missing credential, invalid/expired/revoked token — the token did not
 * resolve, so no bot binding exists). Keeps the `bot_id NOT NULL` invariant
 * without dropping the unattributable-rejection signal, which is exactly the
 * probing traffic an audit trail exists for.
 */
export const LOOPBACK_AUDIT_BOT_ID = '_loopback';

/** Default bot-audit retention (KTD-22): rows older than this are purged. */
export const BOT_AUDIT_RETENTION_DAYS = 90;

/**
 * Fields exempt from the >32-char redaction heuristic (KTD-22): forensic
 * values whose full text is the audit payload. Long values persist verbatim
 * plus a `<key>Sha256` sibling hash so tampering is detectable. Secret-shaped
 * values are masked regardless of exemption.
 */
const REDACTION_EXEMPT_KEYS: ReadonlySet<string> = new Set(['command', 'rule', 'domain']);

/**
 * Correlation-id fields (U6): these carry the audit trail's foreign keys —
 * uuidv4 session/workspace ids are 36 chars and would otherwise redact to
 * `<redacted>`, gutting attribution (this already hid
 * `file_access_denied.details.sessionId` before U6). Stored verbatim with no
 * hash sibling (they are keys, not payloads). The secret-shape check still
 * runs first, and the exemption is name-scoped so a long secret under any
 * other key still redacts.
 */
const CORRELATION_ID_KEYS: ReadonlySet<string> = new Set(['sessionId', 'workspaceId', 'botId', 'requestId']);

/**
 * Secret shapes masked at ANY length in ANY field. Deliberately conservative:
 * false positives (a git-SHA inside a command) redact the whole value, which
 * loses context but never leaks material. The 48-hex capability-token shape
 * (U12) is covered by the long-hex pattern — the auto-redaction invariant
 * from the pre-U6 length heuristic is preserved.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // Provider-style API keys (sk-ant-*, sk-*, etc.).
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // key/token/secret/password/credential assignments: `api_key=…`, `token: …`.
  /\b(?:api[_-]?keys?|access[_-]?tokens?|auth[_-]?tokens?|tokens?|secrets?|passwords?|passwds?|credentials?)\b\s*[:=]/i,
  // HTTP bearer credentials.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  // Long hex blobs: 48-char capability tokens, SHA-1/SHA-256 material.
  /\b[0-9a-f]{40,}\b/,
  // Long base64 blobs (JWT segments, encoded keys).
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeString(key: string, value: string, out: Record<string, unknown>): string {
  if (looksSecret(value)) {
    return '<redacted>';
  }
  if (CORRELATION_ID_KEYS.has(key)) {
    return value;
  }
  if (value.length > 32) {
    if (REDACTION_EXEMPT_KEYS.has(key)) {
      // Exempt forensic field: full text + integrity hash (KTD-22).
      out[`${key}Sha256`] = sha256Hex(value);
      return value;
    }
    // Heuristic: long strings are likely secrets or ciphertext; redact them.
    return '<redacted>';
  }
  return value;
}

/**
 * Sanitize audit details so sensitive values are never persisted or logged.
 * Any nested strings that look like credential material are replaced with
 * `<redacted>` markers; the structure is otherwise preserved. Designated
 * forensic fields (command/rule/domain) keep their full text plus a sha256
 * sibling hash (KTD-22); secret-shaped values are masked regardless.
 */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(key, value, sanitized);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? sanitizeDetails(item as Record<string, unknown>)
          : typeof item === 'string'
            ? looksSecret(item) || item.length > 32
              ? '<redacted>'
              : item
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

/** Requester provenance recorded in details for dual-actor events (KTD-22). */
export interface BotAuditRequester {
  channel: string;
  channelUserId: string;
  role?: string | null;
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
        actorId: actor.channelUserId ?? 'system',
        eventType,
        details: safeDetails,
      });
      diagLog(`[BotAudit] ${eventType}`, { botId, actorType: actor.type, actorId: actor.channelUserId, ...safeDetails });
    } catch (err) {
      diagLog('Failed to record bot audit log', { botId, eventType, error: String(err) });
    }
  }

  logChannelCredentialsChanged(
    botId: string,
    actor: BotActor,
    channels: string[],
  ): void {
    this.log(botId, actor, 'channel_credentials_changed', { channels });
  }

  logChannelEnabled(
    botId: string,
    actor: BotActor,
    channel: BotChannelKey,
  ): void {
    this.log(botId, actor, 'channel_enabled', { channel });
  }

  logChannelDisabled(
    botId: string,
    actor: BotActor,
    channel: BotChannelKey,
  ): void {
    this.log(botId, actor, 'channel_disabled', { channel });
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

  logUserRoleChanged(
    botId: string,
    actor: BotActor,
    channel: BotChannelKey,
    channelUserId: string,
    previousRole: string | null,
    newRole: string,
  ): void {
    this.log(botId, actor, 'user_role_changed', {
      channel,
      channelUserId,
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

  // -------------------------------------------------------------------------
  // U6 (KTD-22): permission-sandbox decision events
  // -------------------------------------------------------------------------

  /**
   * A Bash call denied at the bot gate. `reason` is the structural decision
   * reason (e.g. `degraded-platform-bash`, `bash-whitelist`); `routingClass`
   * is the U3 denial routing class when one exists (legacy-branch denies have
   * none — the kill switch predates routing classes).
   */
  logBashDenied(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      command: string;
      reason: string;
      routingClass?: string;
    },
  ): void {
    this.log(botId, actor, 'bash_denied', details);
  }

  /** An out-of-sandbox request reached the gate (F2), before any routing. */
  logSandboxEscapeRequested(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      command: string;
      role: string | null;
    },
  ): void {
    this.log(botId, actor, 'sandbox_escape_requested', details);
  }

  /**
   * An out-of-sandbox request was approved. Dual-actor provenance (KTD-22):
   * the approver is the actor; the requester rides in details. In phase 1 the
   * approver IS the requester (self-ask, source `self-approval`); U8/U11
   * remote approval records the distinct approver here.
   */
  logSandboxEscapeApproved(
    botId: string,
    approver: BotActor,
    details: {
      sessionId: string;
      command: string;
      requester: BotAuditRequester;
      source: string;
    },
  ): void {
    this.log(botId, approver, 'sandbox_escape_approved', details);
  }

  /**
   * An out-of-sandbox request was denied — by policy (actor `system`) or by
   * an approver (the approver actor, requester in details).
   */
  logSandboxEscapeDenied(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      command: string;
      requester: BotAuditRequester;
      reason: string;
    },
  ): void {
    this.log(botId, actor, 'sandbox_escape_denied', details);
  }

  /** An out-of-sandbox request expired unanswered (fail-closed, AE9). */
  logSandboxEscapeExpired(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      command: string;
      requester: BotAuditRequester;
    },
  ): void {
    this.log(botId, actor, 'sandbox_escape_expired', details);
  }

  /**
   * A passlist rule entered the bot policy (KTD-18 provenance): `source` is
   * `manual` (desktop editor) or `approval` ("always allow" accumulation);
   * `addedBy` carries the provenance identity.
   */
  logPasslistRuleAdded(
    botId: string,
    actor: BotActor,
    details: {
      rule: string;
      source: 'manual' | 'approval';
      addedBy: string;
    },
  ): void {
    this.log(botId, actor, 'passlist_rule_added', details);
  }

  /**
   * A bot session wrote into a workspace capability dir (`.claude/skills`,
   * `.claude/agents` — KTD-29 closed set). Pairs with the desktop banner
   * surface (KTD-24): this event is the audit half of that notification.
   */
  logCapabilityDirWrite(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      toolName: string;
      path: string;
      capabilityDir: string;
      role: string | null;
    },
  ): void {
    this.log(botId, actor, 'capability_dir_write', details);
  }

  // -------------------------------------------------------------------------
  // U6 (U12 integration notes): loopback capability-token lifecycle
  // -------------------------------------------------------------------------

  /**
   * A per-session capability token was minted. NEVER pass the token itself —
   * details carry only the binding (session/workspace) and expiry.
   */
  logCapabilityTokenMinted(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      workspaceId: string;
      expiresAt: string;
    },
  ): void {
    this.log(botId, actor, 'capability_token_minted', details);
  }

  /** A session's capability token(s) were revoked (close/delete/rotation). */
  logCapabilityTokenRevoked(
    botId: string,
    actor: BotActor,
    details: {
      sessionId: string;
      revokedCount: number;
      reason: string;
    },
  ): void {
    this.log(botId, actor, 'capability_token_revoked', details);
  }

  /**
   * A loopback request was rejected by the default-deny auth middleware
   * (U12 diagLog promotion). `botId` is the resolved token's binding, or
   * LOOPBACK_AUDIT_BOT_ID when the rejection is unattributable.
   */
  logLoopbackAuthRejected(
    botId: string,
    actor: BotActor,
    details: {
      method: string;
      path: string;
      reason: string;
      sessionId?: string;
    },
  ): void {
    this.log(botId, actor, 'loopback_auth_rejected', details);
  }
}

export const botAuditLogger = new BotAuditLogger();
