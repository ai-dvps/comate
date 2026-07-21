import type { BotRoleKey, BotRolePolicy } from '../models/bot.js';
import {
  categorizeTool,
  evaluateToolPermission,
  type PermissionDecision,
  type ToolPermissionPolicy,
} from './tool-permission-policy.js';
import { evaluateSkill, type SkillPolicyResult } from './bot-skill-policy.js';

export function isOwnerOrAdmin(role: BotRoleKey | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Evaluate whether a tool is allowed for a bot member.
 *
 * Owner/Admin bypass the Normal tool policy entirely — EXCEPT for the browser
 * category (U4, KTD-4 ①): browser tools are never injected into bot sessions,
 * and the category backstop is fail-closed for every role, admin included.
 * Normal users are evaluated against the normal role's `normalToolPolicy`.
 */
export function evaluateBotToolPermission(
  normalToolPolicy: ToolPermissionPolicy,
  role: BotRoleKey | null | undefined,
  toolName: string,
): PermissionDecision {
  if (isOwnerOrAdmin(role) && categorizeTool(toolName) !== 'browser') {
    return 'allow';
  }
  return evaluateToolPermission(normalToolPolicy, toolName, false);
}

/**
 * Evaluate whether a Skill tool invocation is allowed for a bot member.
 */
export function evaluateBotSkill(
  rolePolicy: BotRolePolicy,
  role: BotRoleKey | null | undefined,
  toolName: string,
  input: Record<string, unknown>,
): SkillPolicyResult {
  return evaluateSkill(
    { policy: rolePolicy, isAdminOrOwner: isOwnerOrAdmin(role) },
    toolName,
    input,
  );
}

/**
 * Check whether a Bash command is allowed for a bot member.
 *
 * Owner/Admin may run any command. Normal users are restricted to commands
 * that start with an entry in the bot's Bash whitelist.
 */
export function isBashCommandAllowed(
  bashWhitelist: string[],
  role: BotRoleKey | null | undefined,
  command: string,
): boolean {
  if (isOwnerOrAdmin(role)) {
    return true;
  }
  const whitelist = bashWhitelist ?? [];
  if (whitelist.length === 0) {
    return false;
  }
  const trimmed = command.trim();
  return whitelist.some((allowed) => allowed !== '' && (trimmed === allowed || trimmed.startsWith(`${allowed} `)),
  );
}
