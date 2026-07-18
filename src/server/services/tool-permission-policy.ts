import type { Workspace } from '../models/workspace.js';
import { BROWSER_TOOL_PREFIX } from './browser-tool-names.js';

/**
 * Tool permission policy for WeCom bot sessions.
 *
 * Replaces the hardcoded allow-all that previously gated every tool call from
 * bot sessions. See docs/brainstorms/2026-06-14-wecom-bot-tool-permissions-requirements.md
 * for the product context and docs/plans/2026-06-14-001-feat-wecom-bot-tool-permissions-plan.md
 * for the implementation plan.
 */

/** The fixed permission categories. Reply is a named exception: it gates the WeCom send-message path, not an SDK tool. Browser (U4) covers the embedded-browser MCP tools (`mcp__comate-browser__*`). */
export type ToolCategory =
  | 'fileRead'
  | 'fileWrite'
  | 'shell'
  | 'network'
  | 'subagents'
  | 'reply'
  | 'browser';

/** Posture is UI shorthand only; the evaluator never reads it. Selecting a preset rewrites categoryDefaults; manual toggles flip posture to 'custom'. */
export type ToolPosture = 'allow-all' | 'safe' | 'custom';

export interface ToolPermissionPolicy {
  posture: ToolPosture;
  categoryDefaults: Record<ToolCategory, 'allow' | 'deny' | 'ask'>;
  /** Optional per-tool overrides that invert the category default for named tools. Keys are SDK tool names (e.g., 'Bash', 'Edit'). */
  overrides?: Record<string, 'allow' | 'deny' | 'ask'>;
}

/** Sentinel tool name for the Reply capability. Reply is not an SDK tool — it is the WeCom send-message path. */
export const REPLY_TOOL_NAME = '__wecom_reply__';

/**
 * Maps each category to the SDK tool names it owns. Per R3 of the brainstorm.
 * Entries ending in `*` are PREFIX entries: `mcp__<server>__*` categorizes
 * every tool of that MCP server (U4 — only the embedded browser server uses
 * this; other MCP tools stay uncategorized and fall through per R10).
 */
export const CATEGORY_TOOL_MAP: Record<ToolCategory, string[]> = {
  fileRead: ['Read', 'Glob', 'Grep'],
  fileWrite: ['Edit', 'Write', 'NotebookEdit'],
  shell: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
  subagents: [
    'Agent',
    'TaskOutput',
    'TaskStop',
    'TaskCreate',
    'TaskGet',
    'TaskUpdate',
    'TaskList',
  ],
  reply: [REPLY_TOOL_NAME],
  browser: [`${BROWSER_TOOL_PREFIX}*`],
};

/** Reverse lookup: exact tool name → category. Built once at module load. */
const TOOL_TO_CATEGORY: Map<string, ToolCategory> = (() => {
  const map = new Map<string, ToolCategory>();
  for (const [category, tools] of Object.entries(CATEGORY_TOOL_MAP)) {
    for (const tool of tools) {
      if (tool.endsWith('*')) continue; // prefix entries handled below
      map.set(tool, category as ToolCategory);
    }
  }
  return map;
})();

/** Prefix entries (`mcp__<server>__*` → category), longest prefix first. */
const CATEGORY_PREFIXES: Array<{ prefix: string; category: ToolCategory }> = (() => {
  const entries: Array<{ prefix: string; category: ToolCategory }> = [];
  for (const [category, tools] of Object.entries(CATEGORY_TOOL_MAP)) {
    for (const tool of tools) {
      if (tool.endsWith('*')) {
        entries.push({ prefix: tool.slice(0, -1), category: category as ToolCategory });
      }
    }
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
})();

/**
 * Categorize a tool: exact name match first, then `*` prefix entries.
 * Returns undefined for tools in no category (other MCP servers, Skill,
 * future SDK built-ins) — callers fall through per R10.
 */
export function categorizeTool(toolName: string): ToolCategory | undefined {
  const exact = TOOL_TO_CATEGORY.get(toolName);
  if (exact) return exact;
  for (const { prefix, category } of CATEGORY_PREFIXES) {
    if (toolName.startsWith(prefix)) return category;
  }
  return undefined;
}

/** The safe preset: read-only + reply allowed; write/shell/network/sub-agents denied. Applied automatically to new bot-enabled workspaces per R6. Browser stays denied (U4: bots never get browser tools). */
export const SAFE_PRESET: ToolPermissionPolicy = {
  posture: 'safe',
  categoryDefaults: {
    fileRead: 'allow',
    fileWrite: 'deny',
    shell: 'deny',
    network: 'deny',
    subagents: 'deny',
    reply: 'allow',
    browser: 'deny',
  },
};

/**
 * The allow-all posture: today's hardcoded behavior. Used for grandfathered pre-feature deployments per R5/R7.
 * EXCEPTION (U4, KTD-4 ①): `browser` is deny even here — allow-all predates
 * the browser category, and grandfathered policies must not silently inherit
 * a capability that did not exist when they were written.
 */
export const ALLOW_ALL_PRESET: ToolPermissionPolicy = {
  posture: 'allow-all',
  categoryDefaults: {
    fileRead: 'allow',
    fileWrite: 'allow',
    shell: 'allow',
    network: 'allow',
    subagents: 'allow',
    reply: 'allow',
    browser: 'deny',
  },
};

/** Result of evaluateToolPermission. 'unknown' means the tool is not in any category (MCP, Skill, future SDK tool without a category fit) — callers fall through to today's allow-all behavior per R10. */
export type PermissionDecision = 'allow' | 'deny' | 'ask' | 'unknown';

/**
 * Evaluate whether a tool is allowed under a policy.
 *
 * Resolution order per R4:
 *   1. Per-tool override (if present)
 *   2. Category default
 *   3. 'unknown' if the tool is not in any category (caller falls through to allow per R10)
 *
 * If the policy is undefined, returns 'unknown' so callers fall through to allow-all (the pre-feature default).
 *
 * NOTE: If you change this resolution order, also update `getToolPermissionDenialReason`
 * so the two functions stay in sync.
 */
export function evaluateToolPermission(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
  isAdmin = false,
): PermissionDecision {
  if (!policy) return 'unknown';

  // WeCom bot admins bypass category defaults and per-tool overrides for all
  // categorized SDK tools and the Reply capability. EXCEPTION (U4, KTD-4 ①):
  // the browser category is exempt from the admin bypass — browser tools are
  // never injected into bot sessions, and the category is a fail-closed
  // backstop, not an admin-reachable capability.
  if (isAdmin) {
    const category = categorizeTool(toolName);
    if (category && category !== 'browser') return 'allow';
  }

  // Per-tool override takes precedence
  const override = policy.overrides?.[toolName];
  if (override === 'allow') return 'allow';
  if (override === 'deny') return 'deny';
  if (override === 'ask') return 'ask';

  // Category default. A category missing from a stored policy (e.g. `browser`
  // in a pre-U4 policy) falls back to SAFE_PRESET — fail-closed migration
  // contract: categories added later must never default to allow.
  const category = categorizeTool(toolName);
  if (!category) return 'unknown';
  return policy.categoryDefaults[category] ?? SAFE_PRESET.categoryDefaults[category];
}

/** Reason for a policy-level denial. Mirrors the resolution order of `evaluateToolPermission`. */
export type ToolDenialReason = 'override-deny' | 'category-deny';

/**
 * Return the reason a tool was denied by policy, or `undefined` if it was not
 * denied. Keeps the override-vs-category resolution logic in one place and in
 * sync with `evaluateToolPermission`.
 */
export function getToolPermissionDenialReason(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
): ToolDenialReason | undefined {
  if (!policy) return undefined;

  const override = policy.overrides?.[toolName];
  if (override === 'deny') return 'override-deny';
  // An allow/ask override means this tool is not denied at the override layer,
  // regardless of the category default.
  if (override === 'allow' || override === 'ask') return undefined;

  const category = categorizeTool(toolName);
  if (!category) return undefined;

  // Missing category key in a stored policy falls back to SAFE_PRESET
  // (fail-closed), mirroring evaluateToolPermission.
  const decision = policy.categoryDefaults[category] ?? SAFE_PRESET.categoryDefaults[category];
  if (decision === 'deny') return 'category-deny';
  return undefined;
}

/** Source of an effective policy. Drives the grandfathering prompt and the policy viewer UI. */
export type PolicySource =
  | 'explicit' // wecomToolPermissions is set on the workspace
  | 'grandfathered-allow-all' // bot enabled, policy unset → allow-all with upgrade prompt
  | 'default-allow-all'; // bot disabled, policy unset → allow-all (no prompt; GUI sessions unaffected)

export interface ResolvedPolicy {
  policy: ToolPermissionPolicy;
  source: PolicySource;
  /** True when the workspace is bot-enabled and the policy is unset (the grandfathering case). The UI uses this to show the one-time upgrade banner. */
  needsUpgradePrompt: boolean;
}

/**
 * Resolve the effective policy for a workspace.
 *
 * - If `wecomToolPermissions` is set: use it as-is (source='explicit').
 * - If bot enabled but policy unset: allow-all + needsUpgradePrompt=true (grandfathered; per R7/R8).
 * - If bot disabled and policy unset: allow-all + no prompt (GUI sessions unaffected; per R1).
 *
 * The resolved policy is always a valid ToolPermissionPolicy. Callers do not need to handle undefined.
 */
export function resolveEffectivePolicy(workspace: Workspace): ResolvedPolicy {
  const explicit = workspace.settings.wecomToolPermissions;
  if (explicit) {
    return {
      policy: sanitizePolicy(explicit),
      source: 'explicit',
      needsUpgradePrompt: false,
    };
  }

  if (workspace.settings.wecomBotEnabled) {
    return {
      policy: ALLOW_ALL_PRESET,
      source: 'grandfathered-allow-all',
      needsUpgradePrompt: true,
    };
  }

  return {
    policy: ALLOW_ALL_PRESET,
    source: 'default-allow-all',
    needsUpgradePrompt: false,
  };
}

/**
 * Normalize a stored policy into a valid shape. Fills missing categories from SAFE_PRESET defaults
 * (defensive — see doc-review finding about malformed-shape shadow path).
 *
 * MIGRATION CONTRACT (U4, KTD-4 ①): backfilling from SAFE_PRESET is the
 * fail-closed migration path for categories added after a policy was stored.
 * A pre-U4 policy has no `browser` key; sanitizePolicy rewrites it to
 * `browser: 'deny'` (SAFE's value) rather than leaving a hole that could
 * default to allow. This is a contract, not a behavior coincidence — pinned
 * by tool-permission-policy.test.ts.
 */
function sanitizePolicy(policy: ToolPermissionPolicy): ToolPermissionPolicy {
  const categoryDefaults = { ...SAFE_PRESET.categoryDefaults };
  for (const key of Object.keys(categoryDefaults) as ToolCategory[]) {
    const value = policy.categoryDefaults?.[key];
    if (value === 'allow' || value === 'deny' || value === 'ask') {
      categoryDefaults[key] = value;
    }
  }

  const overrides: Record<string, 'allow' | 'deny' | 'ask'> = {};
  if (policy.overrides && typeof policy.overrides === 'object') {
    for (const [tool, value] of Object.entries(policy.overrides)) {
      if (value === 'allow' || value === 'deny' || value === 'ask') {
        overrides[tool] = value;
      }
    }
  }

  const posture: ToolPosture =
    policy.posture === 'allow-all' || policy.posture === 'safe' || policy.posture === 'custom'
      ? policy.posture
      : 'custom';

  return {
    posture,
    categoryDefaults,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  };
}
