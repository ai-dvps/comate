import {
  store as defaultStore,
  type BrowserAuditEntry,
  type CreateBrowserAuditInput,
  type SqliteStore,
} from '../storage/sqlite-store.js';
import { diagWarn } from '../utils/diag-logger.js';
import { originOf } from './browser-origin.js';

// Re-exported so existing consumers of './browser-audit.js' keep working; the
// canonical home is browser-origin.ts.
export { originOf };

/**
 * browser-audit — the write path for the `browser_audit` table (U8, KTD-9).
 *
 * The audit contract is POSITIVE SHAPE, enforced structurally: every log
 * method derives its own persisted fields from typed inputs, so there is no
 * parameter through which a field value, credential, cookie, or image could
 * reach the table. What MAY be persisted:
 *
 *   - tool / verb / event names (action)
 *   - categories (tool | control | navigation | site_auth)
 *   - URL ORIGINS (scheme + host + port, derived here from the full URL —
 *     never path/query, which can carry tokens)
 *   - field NAMES (submit forms) — values never
 *   - outcomes + the RISK-1 potential-submit marker
 *   - bounded, pre-sanitized detail strings (truncated here)
 *
 * This deliberately does NOT reuse bot-audit-logger's sanitizer: its
 * ">32 chars is probably a secret" heuristic mangles URLs, which are
 * legitimate audit content under an origin-scoped contract.
 */

/** Hard bounds so a pathological input can never bloat a row. */
const DETAIL_MAX_CHARS = 256;
const FIELD_NAME_MAX_CHARS = 128;
const FIELD_NAMES_MAX_COUNT = 64;
const ACTION_MAX_CHARS = 128;

function clampString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeFieldNames(names: readonly string[] | undefined): string[] {
  if (!names) return [];
  return names.slice(0, FIELD_NAMES_MAX_COUNT).map((name) => clampString(String(name), FIELD_NAME_MAX_CHARS));
}

export interface BrowserAuditToolInput {
  workspaceId: string;
  sessionId: string;
  /** Full tool name, e.g. `mcp__comate-browser__act`. */
  toolName: string;
  /** Full URL — reduced to its origin before persisting. */
  url?: string;
  fieldNames?: readonly string[];
  outcome: CreateBrowserAuditInput['outcome'];
  /** RISK-1: click that cannot be proven harmless was followed by navigation. */
  potentialSubmit?: boolean;
  detail?: string;
}

export interface BrowserAuditNavigationInput {
  workspaceId: string;
  sessionId: string;
  /** eTLD+1 (port-scoped for IP/localhost) from the navigation ledger. */
  domain: string;
  /** Ledger outcome: first-visit | first-cross-confirmed | cross-domain-auto. */
  kind: 'first-visit' | 'first-cross-confirmed' | 'cross-domain-auto';
  outcome: CreateBrowserAuditInput['outcome'];
}

export interface BrowserAuditControlInput {
  workspaceId: string;
  sessionId: string;
  /**
   * Control-plane event: takeover | handback | handoff_requested |
   * handoff_granted | handoff_declined | handoff_handed_back |
   * handoff_timeout | handoff_crash | handoff_runtime_closed |
   * browser_closed_agent | browser_closed_human | browser_closed_idle |
   * browser_closed_timeout | idle_prompt_shown (U1/U3 explicit-close paths).
   * (activity_ping is deliberately not audited — content-free churn.)
   */
  verb: string;
  outcome: CreateBrowserAuditInput['outcome'];
  detail?: string;
}

export interface BrowserAuditSiteAuthInput {
  workspaceId: string;
  sessionId?: string | null;
  siteKey: string;
  action: 'remember' | 'revoke' | 'inject';
  outcome: CreateBrowserAuditInput['outcome'];
  /** Pre-sanitized context (counts, error codes — never values). */
  detail?: string;
}

export class BrowserAuditService {
  private readonly store: SqliteStore;

  constructor(store?: SqliteStore) {
    this.store = store ?? defaultStore;
  }

  /** Low-level write — normalizes and never throws (audit must not break flows). */
  record(input: CreateBrowserAuditInput): BrowserAuditEntry | null {
    try {
      return this.store.recordBrowserAudit({
        ...input,
        action: clampString(input.action, ACTION_MAX_CHARS),
        fieldNames: normalizeFieldNames(input.fieldNames),
        detail: input.detail ? clampString(input.detail, DETAIL_MAX_CHARS) : null,
      });
    } catch (err) {
      diagWarn('[browser-audit] failed to persist audit row:', err);
      return null;
    }
  }

  logToolAction(input: BrowserAuditToolInput): BrowserAuditEntry | null {
    return this.record({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      category: 'tool',
      action: input.toolName,
      origin: originOf(input.url),
      fieldNames: input.fieldNames ? [...input.fieldNames] : [],
      outcome: input.outcome,
      potentialSubmit: input.potentialSubmit ?? false,
      detail: input.detail ?? null,
    });
  }

  logNavigation(input: BrowserAuditNavigationInput): BrowserAuditEntry | null {
    return this.record({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      category: 'navigation',
      action: input.kind,
      siteKey: input.domain,
      outcome: input.outcome,
    });
  }

  logControl(input: BrowserAuditControlInput): BrowserAuditEntry | null {
    return this.record({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      category: 'control',
      action: input.verb,
      outcome: input.outcome,
      detail: input.detail ?? null,
    });
  }

  logSiteAuth(input: BrowserAuditSiteAuthInput): BrowserAuditEntry | null {
    return this.record({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      category: 'site_auth',
      action: input.action,
      siteKey: input.siteKey,
      outcome: input.outcome,
      detail: input.detail ?? null,
    });
  }

  list(
    workspaceId: string,
    options: { sessionId?: string; limit?: number } = {},
  ): BrowserAuditEntry[] {
    return this.store.listBrowserAudit(workspaceId, options);
  }
}

export const browserAuditService = new BrowserAuditService();
