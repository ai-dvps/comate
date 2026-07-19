/**
 * browser-gate-state — session-scoped state for the canUseTool-layer browser
 * gates (U4, KTD-4 ② and the navigation surface of RISK-1).
 *
 * Two registries, both keyed by chat sessionId and both deliberately
 * module-level (like browser-mcp's pageRegistry) so they survive runtime
 * rebuilds — the browser session outlives the runtime (KTD-5):
 *
 *  1. Submit-semantics ref registry. The BrowserToolContext knows which
 *     element refs submit a form (type=submit / in-form default buttons —
 *     implicit submission via Enter activates the same default control, and
 *     the v1 act surface has no key-press action, so the Enter rule is
 *     subsumed by the click rule). The canUseTool layer needs that knowledge
 *     to classify `act` clicks before the auto branch; this registry is the
 *     bridge. It is rewritten on every distill and cleared when the page
 *     dies, so it can never authorize a click the live page no longer
 *     describes — and a stale entry can only over-classify (ask when it
 *     could have auto-approved), never under-classify.
 *
 *  2. Navigation ledger. Session-level memory of visited eTLD+1 domains for
 *     the auto-mode first-cross-domain confirmation (KTD-4 ②: one
 *     confirmation per session, no persistent domain ledger). In auto mode
 *     the first navigation establishes the home domain; the first crossing
 *     to a NEW domain requires one confirmation; later crossings to further
 *     new domains land as browser_audit rows (U8 — the diagLog placeholders
 *     in session-runtime are gone).
 *
 * eTLD+1 comes from browser-site-key.ts (tldts / real PSL since U8 — the
 * pre-U8 heuristic lived here; the re-export below keeps this module's
 * import surface stable).
 */

import { BROWSER_TOOL_NAMES } from './browser-tool-names.js';
import { registrableDomain } from './browser-site-key.js';

// The eTLD+1 rule lives in browser-site-key.ts (U8: tldts/PSL, single home —
// this module previously carried a last-two-labels heuristic). Re-exported
// here so existing gate consumers/tests keep their import site.
export { registrableDomain };

// ---------------------------------------------------------------------------
// Submit-semantics ref registry
// ---------------------------------------------------------------------------

const submitSemanticsRefs = new Map<string, Set<string>>();

/** Replace the session's submit-semantics ref set (called on every distill). */
export function setSubmitSemanticsRefs(sessionId: string, refs: Iterable<string>): void {
  submitSemanticsRefs.set(sessionId, new Set(refs));
}

/** True when the ref is currently known to submit a form for this session. */
export function isSubmitSemanticsRef(sessionId: string, ref: string): boolean {
  return submitSemanticsRefs.get(sessionId)?.has(ref) ?? false;
}

/** Drop only the submit-semantics refs (page died — refs no longer describe a live page). */
export function clearSubmitSemanticsRefs(sessionId: string): void {
  submitSemanticsRefs.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Submit classification (canUseTool-layer twin of the handler-level rules)
// ---------------------------------------------------------------------------

/**
 * Provable-submit classification for the canUseTool gate (U4, KTD-4 ②).
 * Mirrors the handler-level rules in browser-mcp:
 *  - the submit tool itself is always submit-classified;
 *  - `act` clicking a ref the latest page model marks as submit-semantics
 *    (type=submit / type=image inputs, in-form default buttons) is
 *    submit-classified — implicit submission via Enter activates the same
 *    default control, and the v1 act surface has no key-press action, so the
 *    form-Enter rule is subsumed by this click rule;
 *  - everything else (ordinary link clicks, fills, selects, checks) follows
 *    the session approval mode, per RISK-1's accepted-residual line.
 *
 * This is only the FIRST gate + UI entry. The real hard gate (sanitized
 * manifest + TOCTOU re-read) lives in the submit tool's handler (U3) and
 * fires regardless of what this layer decides — a `.claude/settings.json`
 * `permissions.allow` rule can short-circuit canUseTool entirely.
 */
export function isBrowserSubmitClassified(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === BROWSER_TOOL_NAMES.submit) return true;
  if (
    toolName === BROWSER_TOOL_NAMES.act &&
    input.action === 'click' &&
    typeof input.ref === 'string'
  ) {
    return isSubmitSemanticsRef(sessionId, input.ref);
  }
  return false;
}

/**
 * Redact a submit-classified call's raw input for the canUseTool-layer
 * approval card. The submit tool's `fields` values may include credentials
 * the agent is about to fill; the KTD-8 ruleset allows field NAMES into the
 * pending_approval stream but never values. The handler-level gate renders
 * the full sanitized manifest — this card only needs names.
 */
export function redactSubmitGateInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== BROWSER_TOOL_NAMES.submit) return input;
  const fields = input.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return input;
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(fields as Record<string, unknown>)) {
    redacted[key] = '(redacted — shown in the submit confirmation)';
  }
  return { ...input, fields: redacted };
}

// ---------------------------------------------------------------------------
// Navigation ledger
// ---------------------------------------------------------------------------

export type SessionNavigationVerdict =
  | {
      kind: 'allow';
      domain: string;
      /** True for the session's very first navigation (establishes home). */
      firstVisit: boolean;
      /** True for crossings that pass without confirmation — audit marker. */
      auditCrossing: boolean;
    }
  | { kind: 'needs-confirm'; domain: string }
  /** Unparseable / non-http(s) URL — the caller falls through to normal flow. */
  | { kind: 'invalid' };

interface NavigationLedgerEntry {
  visited: Set<string>;
  /** Set once the session's first cross-domain confirmation was granted. */
  crossConfirmed: boolean;
}

const navigationLedger = new Map<string, NavigationLedgerEntry>();
/** Bounded FIFO so long-lived sidecars cannot grow the ledger without limit. */
const NAVIGATION_LEDGER_CAP = 512;

function ledgerEntry(sessionId: string): NavigationLedgerEntry {
  let entry = navigationLedger.get(sessionId);
  if (!entry) {
    entry = { visited: new Set(), crossConfirmed: false };
    navigationLedger.set(sessionId, entry);
    while (navigationLedger.size > NAVIGATION_LEDGER_CAP) {
      const oldest = navigationLedger.keys().next().value;
      if (oldest === undefined) break;
      navigationLedger.delete(oldest);
    }
  }
  return entry;
}

/**
 * Well-known second-level public suffixes — REMOVED in U8: the real PSL
 * (tldts, allowPrivateDomains) now lives in browser-site-key.ts and is
 * re-exported above. The historical note stays: a miss only ever over-groups
 * (a.co.uk and b.co.uk share a domain), never under-groups, so the
 * confirmation fires at least as often as a real PSL would require — the
 * tldts rule preserves that direction.
 */

/**
 * Evaluate a navigation for the session. Pure — commit separately via
 * `commitSessionNavigation` once the navigation is actually permitted.
 */
export function evaluateSessionNavigation(
  sessionId: string,
  rawUrl: string,
): SessionNavigationVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid' };
  }
  const domain = registrableDomain(parsed);
  const entry = ledgerEntry(sessionId);
  if (entry.visited.has(domain)) {
    return { kind: 'allow', domain, firstVisit: false, auditCrossing: false };
  }
  if (entry.visited.size === 0) {
    return { kind: 'allow', domain, firstVisit: true, auditCrossing: false };
  }
  if (!entry.crossConfirmed) {
    return { kind: 'needs-confirm', domain };
  }
  return { kind: 'allow', domain, firstVisit: false, auditCrossing: true };
}

/**
 * Record a permitted navigation. `confirmedCrossing` marks the session's
 * one-time first-cross confirmation as spent (KTD-4 ②).
 */
export function commitSessionNavigation(
  sessionId: string,
  domain: string,
  options: { confirmedCrossing?: boolean } = {},
): void {
  const entry = ledgerEntry(sessionId);
  entry.visited.add(domain);
  if (options.confirmedCrossing) {
    entry.crossConfirmed = true;
  }
}

/** Test/debug introspection: the session's visited domains. */
export function getVisitedDomains(sessionId: string): readonly string[] {
  return [...(navigationLedger.get(sessionId)?.visited ?? [])];
}

/** Drop all gate state for a session (session teardown / test isolation). */
export function clearBrowserGateSession(sessionId: string): void {
  submitSemanticsRefs.delete(sessionId);
  navigationLedger.delete(sessionId);
}
