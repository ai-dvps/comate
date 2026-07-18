/**
 * Client-side mirror of the server-side ToolPermissionPolicy shape.
 *
 * Defined separately (not imported from src/server) so the client bundle does
 * not pull in server modules. Keep in sync with
 * src/server/services/tool-permission-policy.ts.
 */

export type ToolCategory =
  | 'fileRead'
  | 'fileWrite'
  | 'shell'
  | 'network'
  | 'subagents'
  | 'reply'
  | 'browser';

export type ToolPosture = 'allow-all' | 'safe' | 'custom';

export type CategoryDecision = 'allow' | 'deny' | 'ask';

export interface ToolPermissionPolicy {
  posture: ToolPosture;
  categoryDefaults: Record<ToolCategory, CategoryDecision>;
  overrides?: Record<string, CategoryDecision>;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  'fileRead',
  'fileWrite',
  'shell',
  'network',
  'subagents',
  'reply',
  'browser',
];

/** Maps each category to the SDK tool names it owns. Mirrors the server CATEGORY_TOOL_MAP. Reply is a sentinel-only category. Browser is a prefix entry (`mcp__comate-browser__*`). */
export const CATEGORY_TOOLS: Record<ToolCategory, string[]> = {
  fileRead: ['Read', 'Glob', 'Grep'],
  fileWrite: ['Edit', 'Write', 'NotebookEdit'],
  shell: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
  subagents: ['Agent', 'TaskOutput', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'],
  reply: ['__wecom_reply__'],
  browser: ['mcp__comate-browser__*'],
};

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
