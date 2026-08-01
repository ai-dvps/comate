/**
 * bot-escalation-guard (U11, KTD-18/KTD-19) — pure decision helpers for the
 * out-of-sandbox escalation path: dedupe signatures (generalized rule form),
 * anti-spam caps, and the always-allow rule computation (exact-match only).
 *
 * Kept free of store/service imports so the gate (chat-service), the card
 * layer (wecom-bot-service), and tests share one source of truth.
 */

import type { PermissionSuggestion } from '../types/message.js';

// ---------------------------------------------------------------------------
// Anti-spam caps (KTD-19)
// ---------------------------------------------------------------------------

/**
 * Per-user-per-bot hourly cap on created escalations. Beyond it a new
 * escalation fails closed with a notice — one requester cannot card-spam the
 * channel's owner/admin.
 */
export const ESCALATION_PER_USER_HOURLY_CAP = 10;

/**
 * Per-bot global cap on outstanding (pending) escalations. Beyond it a new
 * escalation fails closed with a notice — the approver queue stays bounded
 * even when many requesters escalate at once.
 */
export const ESCALATION_GLOBAL_PENDING_CAP = 20;

/**
 * Per-turn override-deny cap: after this many out-of-sandbox DENIES in one
 * turn (dedupe denies, cap denies, approver denies, expiries), the gate
 * short-circuits with an explicit stop-retry instruction instead of the
 * normal routing message. The breaker for model retry loops.
 */
export const OVERRIDE_DENY_CAP_PER_TURN = 4;

/** Window for the per-user hourly cap. */
export const ESCALATION_USER_CAP_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Escalation reasons (U9 plugs network/mcp-write classification into these)
// ---------------------------------------------------------------------------

/**
 * Why a tool call escalated. `escape` is the U11-implemented path
 * (dangerouslyDisableSandbox retry); `network` and `mcp-write` are accepted
 * NOW so U9's MCP/network classification routes through the same pending +
 * card flow without rework (KTD-20: normal → admins audience).
 */
export type BotEscalationReason = 'escape' | 'network' | 'mcp-write';

// ---------------------------------------------------------------------------
// Dedupe signature (KTD-19): generalized rule form
// ---------------------------------------------------------------------------

/** Wrapper tokens the SDK rule engine strips before matching (U4 contract). */
const WRAPPER_TOKENS = new Set(['timeout', 'nice', 'command']);

/**
 * First meaningful token of a shell command, after stripping the wrapper
 * prefixes the SDK rule engine strips (`timeout 5 …`, `nice -n 1 …`,
 * `command …`). Used for dedupe generalization only — never for permission
 * decisions (those are the structural rule engine's job).
 */
function firstCommandToken(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== '');
  let i = 0;
  while (i < tokens.length && WRAPPER_TOKENS.has(tokens[i])) {
    const wrapper = tokens[i];
    i += 1;
    // Skip wrapper arguments: `timeout 5`, `nice -n 1` (and `nice -1`).
    if (wrapper === 'timeout' && i < tokens.length && /^-?\d/.test(tokens[i])) i += 1;
    if (wrapper === 'nice' && i < tokens.length && /^-/.test(tokens[i])) {
      i += 1;
      if (tokens[i - 1] === '-n' && i < tokens.length && /^\d/.test(tokens[i])) i += 1;
    }
  }
  return tokens[i] ?? '';
}

/**
 * Generalized dedupe signature (KTD-19): parameter variants of the same
 * command shape collapse into ONE pending (`curl https://a.com/1` and
 * `curl https://a.com/2` share a signature). This is deliberately COARSE —
 * it only bounds card spam; the persisted always-allow rule stays exact.
 * For compound commands the per-subcommand first tokens compose the
 * signature so `git status && curl x` and `git status && curl y` dedupe
 * together.
 */
export function generalizedEscalationSignature(input: {
  reason: BotEscalationReason;
  toolName: string;
  command?: string;
}): string {
  const command = input.command?.trim();
  if (!command) {
    return `${input.reason}(${input.toolName})`;
  }
  const subcommands = command
    .split(/&&|\|\||[;|]/)
    .map((part) => firstCommandToken(part))
    .filter((token) => token !== '')
    .sort();
  return `${input.reason}(${input.toolName}:${subcommands.join(',')})`;
}

// ---------------------------------------------------------------------------
// Always-allow rule computation (KTD-18)
// ---------------------------------------------------------------------------

/**
 * Composite-command detector (KTD-18): the passlist holds single literal
 * subcommands because the SDK rule engine evaluates compound commands
 * per-subcommand — a passlist entry must never itself be a composition.
 * Mirrors the U4 desktop editor's pattern (BotRolePermissions.tsx).
 */
export const COMPOSITE_COMMAND_PATTERN = /\|\||&&|[;|`]|\$\(/;

export interface AlwaysAllowComputation {
  /**
   * Exact-match rules "始终允许" would persist (e.g. `Bash(curl https://a.com/x)`).
   * Empty ⇒ the always-allow button is suppressed.
   */
  rules: string[];
  /** Why the button is suppressed (for card prose + audit); undefined when rules exist. */
  suppressedReason?: string;
}

/**
 * Compute the exact-match rules an always-allow resolution would persist
 * (KTD-18):
 * - Only `{type:'addRules', behavior:'allow'}` suggestions are persistable;
 *   any other suggestion type (setMode/addDirectories/replaceRules/…) is
 *   dropped AND suppresses the button (its presence means the SDK wanted a
 *   change we refuse to make durable).
 * - The persisted rule is EXACT-MATCH: the literal command (`Bash(<command>)`),
   * never a wildcard generalization — approving `curl https://a.com/x` must
   * not match `curl https://evil.com` (AE8).
 * - Composite commands cannot be expressed as one exact rule (the engine
 *   evaluates per subcommand) → suppressed.
 * - Non-Bash tools have no command-literal rule form yet (U9 adds MCP rule
 *   forms) → suppressed.
 */
export function computeAlwaysAllowRules(input: {
  toolName: string;
  command?: string;
  suggestions?: PermissionSuggestion[];
}): AlwaysAllowComputation {
  const command = input.command?.trim();
  if (input.toolName !== 'Bash' || !command) {
    return { rules: [], suppressedReason: 'no-exact-rule-form' };
  }
  if (COMPOSITE_COMMAND_PATTERN.test(command)) {
    return { rules: [], suppressedReason: 'composite-command' };
  }
  const suggestions = input.suggestions ?? [];
  const addRulesAllow = suggestions.filter((s) => s.type === 'addRules' && s.behavior === 'allow');
  const droppedTypes = [
    ...new Set(
      suggestions
        .filter((s) => !(s.type === 'addRules' && s.behavior === 'allow'))
        .map((s) => s.type),
    ),
  ].sort();
  if (droppedTypes.length > 0) {
    return { rules: [], suppressedReason: `dropped-suggestion-types:${droppedTypes.join(',')}` };
  }
  if (addRulesAllow.length === 0) {
    return { rules: [], suppressedReason: 'no-addRules-suggestion' };
  }
  return { rules: [`Bash(${command})`] };
}

/**
 * The session-scoped updatedPermissions passed to the SDK on an always-allow
 * resolution (KTD-18): addRules + allow + destination 'session' ONLY — the
 * in-memory session layer, never a settings file. Rule content is the same
 * exact literal as the persisted passlist rule.
 */
export function exactSessionUpdatedPermissions(rules: string[]): Array<{
  type: 'addRules';
  rules: Array<{ toolName: string; ruleContent: string }>;
  behavior: 'allow';
  destination: 'session';
}> {
  const parsed = rules
    .map((rule) => {
      const match = /^(\w+)\((.*)\)$/.exec(rule);
      return match ? { toolName: match[1], ruleContent: match[2] } : null;
    })
    .filter((r): r is { toolName: string; ruleContent: string } => r !== null);
  if (parsed.length === 0) return [];
  return [{ type: 'addRules', rules: parsed, behavior: 'allow', destination: 'session' }];
}
