/**
 * mcp-tool-classification (U9, R10/KTD-20) — classify MCP tools into
 * read / write / unknown so the bot gate can route write-class and
 * unknown-class calls into the approval escalation path instead of the
 * pre-U9 allow-all fall-through.
 *
 * Why a separate module: the ToolCategory taxonomy in
 * tool-permission-policy.ts is UI-exposed (the category toggles render in
 * the desktop permissions tab), so MCP read/write semantics must NOT be
 * folded into it — a taxonomy ripple there would rewrite the UI contract.
 * This module is a pure leaf (node builtins + types only), following the
 * one-concern-per-file pattern of bot-policy.ts / bot-skill-policy.ts.
 *
 * Classification precedence (KTD-20: 注解优先, per-server 覆盖, unknown → ask):
 *   1. Per-tool override (bot policy, keyed by server then tool name).
 *   2. Per-server default override (bot policy, keyed by server name).
 *   3. Server-provided annotations (MCP spec `readOnlyHint`/`destructiveHint`,
 *      which the SDK normalizes to `readOnly`/`destructive` on
 *      `McpServerStatus.tools[].annotations`).
 *   4. unknown → the gate asks (fail-closed); unknown is NEVER allow-all.
 *
 * MCP server processes are not constrained by the session sandbox, so this
 * classification is enforced at the canUseTool layer (KTD-20) — mounting an
 * MCP server is itself a trust decision made by the desktop administrator.
 */

/** The three MCP tool classes. `unknown` fails closed to the ask route. */
export type McpToolClass = 'read' | 'write' | 'unknown';

/**
 * Server-provided tool annotations, as normalized by the SDK's
 * `McpServerStatus.tools[].annotations` (MCP spec `readOnlyHint` →
 * `readOnly`, `destructiveHint` → `destructive`).
 */
export interface McpToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
}

/** Annotations for every tool a session exposes, keyed by the full `mcp__<server>__<tool>` name. */
export type McpToolAnnotationMap = Map<string, McpToolAnnotations>;

/**
 * Per-server classification override stored in the bot role policy
 * (KTD-20: 服务器配置可覆盖). An override can only declare `read` or
 * `write` — `unknown` is never storable (it is the absence of knowledge,
 * not a decision).
 */
export interface McpServerClassificationOverride {
  /** Per-tool overrides — win over the server default AND the annotations. */
  tools?: Record<string, 'read' | 'write'>;
  /** Server-wide default class — wins over annotations. */
  default?: 'read' | 'write';
}

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

/**
 * Split a full MCP tool name (`mcp__<server>__<tool>`) into its segments.
 * Server names may contain single underscores, so the split is ambiguous in
 * the abstract; pass the session's configured server names (`knownServers`)
 * to disambiguate by longest match — the gate always has them. Without a
 * known-server match the name splits at the FIRST `__` (the SDK composition
 * convention). Returns null for non-MCP and malformed names.
 */
export function parseMcpToolName(
  toolName: string,
  knownServers?: readonly string[],
): { server: string; tool: string } | null {
  if (knownServers) {
    let best: { server: string; tool: string } | null = null;
    for (const server of knownServers) {
      const prefix = `mcp__${server}__`;
      if (server === '' || !toolName.startsWith(prefix)) continue;
      const tool = toolName.slice(prefix.length);
      if (tool === '') continue;
      if (!best || server.length > best.server.length) best = { server, tool };
    }
    if (best) return best;
  }
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

/**
 * Classify one MCP tool. Precedence: per-tool override → per-server default
 * override → annotations → unknown.
 *
 * Annotation semantics: `readOnly: true` classifies read UNLESS
 * `destructive: true` is also set (a contradictory server fails toward
 * write); `destructive: true` or an explicit `readOnly: false` (the tool
 * may modify its environment) classify write; anything else is unknown.
 */
export function classifyMcpTool(input: {
  /** Bare tool name within the server (per-tool override lookup key). */
  tool: string;
  annotations?: McpToolAnnotations;
  override?: McpServerClassificationOverride;
}): McpToolClass {
  const toolOverride = input.override?.tools?.[input.tool];
  if (toolOverride === 'read' || toolOverride === 'write') return toolOverride;
  if (input.override?.default === 'read' || input.override?.default === 'write') {
    return input.override.default;
  }
  const annotations = input.annotations;
  if (annotations) {
    if (annotations.destructive === true) return 'write';
    if (annotations.readOnly === true) return 'read';
    if (annotations.readOnly === false) return 'write';
  }
  return 'unknown';
}

function sanitizeClass(value: unknown): 'read' | 'write' | undefined {
  return value === 'read' || value === 'write' ? value : undefined;
}

/**
 * Fail-closed read-path sanitizer for the policy blob field (same contract
 * as sanitizeBotRolePolicy's other fields): invalid entries and invalid
 * class values are dropped; a wholly invalid map collapses to `undefined`
 * (absent = no overrides), never to a widening default.
 */
export function sanitizeMcpClassificationOverrides(
  raw: unknown,
): Record<string, McpServerClassificationOverride> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, McpServerClassificationOverride> = {};
  for (const [server, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (server === '' || typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const override: McpServerClassificationOverride = {};
    const serverDefault = sanitizeClass(record.default);
    if (serverDefault) override.default = serverDefault;
    if (typeof record.tools === 'object' && record.tools !== null && !Array.isArray(record.tools)) {
      const tools: Record<string, 'read' | 'write'> = {};
      for (const [tool, value] of Object.entries(record.tools as Record<string, unknown>)) {
        const cls = sanitizeClass(value);
        if (tool !== '' && cls) tools[tool] = cls;
      }
      if (Object.keys(tools).length > 0) override.tools = tools;
    }
    if (override.default !== undefined || override.tools !== undefined) {
      out[server] = override;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
