import {
  store as defaultStore,
  type BotEscalationEntry,
  type BotEscalationRecipient,
  type BotEscalationRequester,
  type BotEscalationResolution,
  type BotEscalationRulePayload,
  type SqliteStore,
} from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';
import { botAuditLogger, BotAuditLogger } from './bot-audit-logger.js';

/**
 * bot-escalation-ledger (U8 phase-2, KTD-15/KTD-16/KTD-17) — the persistent
 * approval ledger for out-of-sandbox escalation requests, wrapped as a
 * service following the browser-audit store-wrapper pattern.
 *
 * Lifecycle: the bot gate creates a `pending` row when it registers an
 * escalation approval (phase 1: owner/admin self-ask; U11: remote owner/admin
 * cards). The row settles exactly once — approve/deny via the runtime's
 * resolveApproval path, expire via the TTL timer (KTD-17: fail-closed) or via
 * boot recovery (KTD-16: the process died with pendings unsettled, so every
 * pending row is expired at startup; never auto-allowed).
 *
 * Audience model (KTD-15): `audience: 'self'` means only the requester may
 * resolve (today's self-approval); `audience: 'admins'` routes to owner/admin
 * (U11). The invariant `self ⇒ requester role ∈ {owner, admin}` is enforced
 * here at creation by CLAMPING to 'admins' (fail-safe: a misrouted request
 * becomes harder to approve, never easier) with a loud diagLog.
 */

/**
 * Default escalation TTL (KTD-17): 30 minutes, the bottom of the plan's
 * 30–60 minute band. TTL reconciliation finding (U8 pre-work): the SDK's
 * can_use_tool control request carries NO permission deadline — `input.timeout`
 * is the model's own tool parameter (e.g. the Bash tool's command timeout),
 * absent on every observed production request (sse-diag logs show
 * `timeout=none` for all sampled AskUserQuestion events), and the CLI imposes
 * no headless permission-request deadline of its own (only interrupt/stream
 * aborts). The ledger TTL therefore IS the authoritative deadline rather than
 * sitting inside an SDK one; 30 min bounds the pending Promise while leaving
 * humans ample response time. See docs/plans/2026-07-31-001 (KTD-17, V6).
 */
export const ESCALATION_APPROVAL_TTL_MS = 30 * 60 * 1000;

let escalationTtlForTesting: number | undefined;

export function __setEscalationTtlForTesting(ms: number | undefined): void {
  escalationTtlForTesting = ms;
}

/** The TTL a new pending row gets when the tool input carried no timeout. */
export function escalationApprovalTtlMs(): number {
  return escalationTtlForTesting ?? ESCALATION_APPROVAL_TTL_MS;
}

const OWNER_OR_ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export interface CreateEscalationPendingInput {
  /** The approval requestId (toolUseID) — correlation key for the pending. */
  requestId: string;
  botId: string;
  sessionId: string;
  /**
   * Intended audience; clamped to 'admins' when the requester role is not
   * owner/admin (fail-safe invariant, KTD-15).
   */
  audience: 'self' | 'admins';
  requester: BotEscalationRequester;
  recipients?: BotEscalationRecipient[];
  rulePayload: BotEscalationRulePayload;
  /** Explicit TTL (e.g. the tool-input timeout); defaults to the ledger TTL. */
  ttlMs?: number;
  /** Clock injection for tests. */
  now?: number;
}

export class BotEscalationLedgerService {
  private readonly store: SqliteStore;
  private readonly auditLogger: BotAuditLogger;

  constructor(store?: SqliteStore, auditLogger?: BotAuditLogger) {
    this.store = store ?? defaultStore;
    this.auditLogger = auditLogger ?? botAuditLogger;
  }

  /**
   * Register a pending escalation. Never throws — a ledger failure must not
   * break the approval flow it records (the gate proceeds without a ledger
   * link when null is returned).
   */
  createPending(input: CreateEscalationPendingInput): BotEscalationEntry | null {
    try {
      let audience = input.audience;
      if (audience === 'self' && !OWNER_OR_ADMIN_ROLES.has(input.requester.role ?? '')) {
        // KTD-15 invariant, enforced fail-safe: self-audience requires an
        // owner/admin requester. Clamp DOWN to admins and log loudly.
        diagLog(
          `[BotEscalationLedger] audience invariant clamp: requestId=${input.requestId} ` +
            `role=${input.requester.role ?? 'null'} requested audience=self — stored as admins`,
        );
        audience = 'admins';
      }
      const nowMs = input.now ?? Date.now();
      const ttlMs = input.ttlMs ?? escalationApprovalTtlMs();
      return this.store.createBotEscalation({
        id: input.requestId,
        botId: input.botId,
        sessionId: input.sessionId,
        audience,
        requester: input.requester,
        recipients: input.recipients ?? [],
        rulePayload: input.rulePayload,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      });
    } catch (err) {
      diagLog(
        `[BotEscalationLedger] createPending failed requestId=${input.requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  get(requestId: string): BotEscalationEntry | null {
    return this.store.getBotEscalation(requestId);
  }

  /**
   * Settle a pending row as approved/denied. First writer wins — null means
   * the row was already settled (skip side effects; late clicks are no-ops).
   */
  settle(
    requestId: string,
    outcome: 'approved' | 'denied',
    resolution: BotEscalationResolution,
  ): BotEscalationEntry | null {
    try {
      return this.store.transitionBotEscalation(
        requestId,
        outcome,
        resolution,
        new Date().toISOString(),
      );
    } catch (err) {
      diagLog(
        `[BotEscalationLedger] settle(${outcome}) failed requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Settle a pending row as expired (TTL timeout path). First writer wins. */
  expire(requestId: string, resolution: BotEscalationResolution): BotEscalationEntry | null {
    try {
      return this.store.transitionBotEscalation(
        requestId,
        'expired',
        resolution,
        new Date().toISOString(),
      );
    } catch (err) {
      diagLog(
        `[BotEscalationLedger] expire failed requestId=${requestId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Boot recovery (KTD-16): expire every still-pending row (fail-closed —
   * never auto-allow) and write one `sandbox_escape_expired` audit row per
   * entry (actor system, source boot-recovery). Returns the settled entries
   * so the caller can queue requester notifications (flushed per bot when its
   * WeCom connection becomes ready — the boot sequence must not await
   * connections).
   */
  expireAllPendingForBoot(): BotEscalationEntry[] {
    const resolution: BotEscalationResolution = {
      approver: { type: 'system' },
      decision: 'expired',
      source: 'boot-recovery',
    };
    let expired: BotEscalationEntry[];
    try {
      expired = this.store.expireAllPendingBotEscalations(resolution, new Date().toISOString());
    } catch (err) {
      diagLog(
        `[BotEscalationLedger] boot recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
    for (const entry of expired) {
      this.auditLogger.logSandboxEscapeExpired(entry.botId, { type: 'system' }, {
        sessionId: entry.sessionId,
        command: entry.rulePayload.command ?? '',
        requester: entry.requester,
        source: 'boot-recovery',
        requestId: entry.id,
      });
    }
    return expired;
  }
}

export const botEscalationLedger = new BotEscalationLedgerService();
