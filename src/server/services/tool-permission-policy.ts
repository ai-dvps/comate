import type { Workspace } from '../models/workspace.js';

/**
 * Tool permission policy for WeCom bot sessions.
 *
 * Replaces the hardcoded allow-all that previously gated every tool call from
 * bot sessions. See docs/brainstorms/2026-06-14-wecom-bot-tool-permissions-requirements.md
 * for the product context and docs/plans/2026-06-14-001-feat-wecom-bot-tool-permissions-plan.md
 * for the implementation plan.
 */

/** The six fixed permission categories. Reply is a named exception: it gates the WeCom send-message path, not an SDK tool. */
export type ToolCategory =
  | 'fileRead'
  | 'fileWrite'
  | 'shell'
  | 'network'
  | 'subagents'
  | 'reply';

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

/** Maps each category to the SDK tool names it owns. Per R3 of the brainstorm. */
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
};

/** Reverse lookup: tool name → category. Built once at module load. */
const TOOL_TO_CATEGORY: Map<string, ToolCategory> = (() => {
  const map = new Map<string, ToolCategory>();
  for (const [category, tools] of Object.entries(CATEGORY_TOOL_MAP)) {
    for (const tool of tools) {
      map.set(tool, category as ToolCategory);
    }
  }
  return map;
})();

/** The safe preset: read-only + reply allowed; write/shell/network/sub-agents denied. Applied automatically to new bot-enabled workspaces per R6. */
export const SAFE_PRESET: ToolPermissionPolicy = {
  posture: 'safe',
  categoryDefaults: {
    fileRead: 'allow',
    fileWrite: 'deny',
    shell: 'deny',
    network: 'deny',
    subagents: 'deny',
    reply: 'allow',
  },
};

/** The allow-all posture: today's hardcoded behavior. Used for grandfathered pre-feature deployments per R5/R7. */
export const ALLOW_ALL_PRESET: ToolPermissionPolicy = {
  posture: 'allow-all',
  categoryDefaults: {
    fileRead: 'allow',
    fileWrite: 'allow',
    shell: 'allow',
    network: 'allow',
    subagents: 'allow',
    reply: 'allow',
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
 */
export function evaluateToolPermission(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
): PermissionDecision {
  if (!policy) return 'unknown';

  // Per-tool override takes precedence
  const override = policy.overrides?.[toolName];
  if (override === 'allow') return 'allow';
  if (override === 'deny') return 'deny';
  if (override === 'ask') return 'ask';

  // Category default
  const category = TOOL_TO_CATEGORY.get(toolName);
  if (!category) return 'unknown';
  return policy.categoryDefaults[category];
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
