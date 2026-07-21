/**
 * browser-tool-names — lightweight name constants for the embedded browser
 * MCP tool surface (U3/U4, KTD-3/KTD-4).
 *
 * This module is deliberately dependency-free so pure policy modules
 * (tool-permission-policy, bot-policy, session-runtime) can match browser
 * tool names WITHOUT importing browser-mcp.ts — importing that module pulls
 * in the BrowserService singleton (and its storage-dir resolution) at module
 * load. browser-mcp.ts re-exports these constants, so existing imports from
 * './browser-mcp.js' keep working.
 */

export const BROWSER_MCP_SERVER_KEY = 'comate-browser';
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_MCP_SERVER_KEY}__`;

/** Fully qualified SDK tool names of the seven first-class browser tools. */
export const BROWSER_TOOL_NAMES = {
  open: `${BROWSER_TOOL_PREFIX}open`,
  snapshot: `${BROWSER_TOOL_PREFIX}snapshot`,
  act: `${BROWSER_TOOL_PREFIX}act`,
  submit: `${BROWSER_TOOL_PREFIX}submit`,
  extract: `${BROWSER_TOOL_PREFIX}extract`,
  requestHandoff: `${BROWSER_TOOL_PREFIX}requestHandoff`,
  close: `${BROWSER_TOOL_PREFIX}close`,
} as const;

/** True for any tool served by the embedded browser MCP server. */
export function isBrowserToolName(toolName: string): boolean {
  return toolName.startsWith(BROWSER_TOOL_PREFIX);
}
