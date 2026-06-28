import type { Bot, BotRole } from '../models/bot.js';
import {
  evaluateToolPermission,
  type PermissionDecision,
} from './tool-permission-policy.js';
import { evaluateSkill, type SkillPolicyResult } from './bot-skill-policy.js';

export function isOwnerOrAdmin(role: BotRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Evaluate whether a tool is allowed for a bot member.
 *
 * Owner/Admin bypass the Normal tool policy entirely. Normal users are
 * evaluated against `bot.rolePolicy.normalToolPolicy`.
 */
export function evaluateBotToolPermission(
  bot: Bot,
  role: BotRole | null | undefined,
  toolName: string,
): PermissionDecision {
  if (isOwnerOrAdmin(role)) {
    return 'allow';
  }
  return evaluateToolPermission(bot.rolePolicy.normalToolPolicy, toolName, false);
}

/**
 * Evaluate whether a Skill tool invocation is allowed for a bot member.
 */
export function evaluateBotSkill(
  bot: Bot,
  role: BotRole | null | undefined,
  toolName: string,
  input: Record<string, unknown>,
): SkillPolicyResult {
  return evaluateSkill(
    { policy: bot.rolePolicy, isAdminOrOwner: isOwnerOrAdmin(role) },
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
  bot: Bot,
  role: BotRole | null | undefined,
  command: string,
): boolean {
  if (isOwnerOrAdmin(role)) {
    return true;
  }
  const whitelist = bot.rolePolicy.bashWhitelist ?? [];
  if (whitelist.length === 0) {
    return false;
  }
  const trimmed = command.trim();
  return whitelist.some((allowed) => allowed !== '' && (trimmed === allowed || trimmed.startsWith(`${allowed} `)),
  );
}
