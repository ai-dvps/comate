import type { BotRolePolicy } from '../models/bot.js';

export interface SkillPolicyContext {
  policy: BotRolePolicy | undefined;
  isAdminOrOwner: boolean;
}

export interface SkillPolicyResult {
  allowed: boolean;
  reason?: string;
  skillName?: string;
}

function normalizeSkillName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSkillName(input: Record<string, unknown>): string | undefined {
  return (
    normalizeSkillName(input.skill_name) ??
    normalizeSkillName(input.name) ??
    normalizeSkillName(input.skill)
  );
}

export function evaluateSkill(
  ctx: SkillPolicyContext,
  toolName: string,
  input: Record<string, unknown>,
): SkillPolicyResult {
  if (toolName !== 'Skill') {
    return { allowed: true };
  }

  const skillName = extractSkillName(input);
  if (!skillName) {
    return { allowed: false, reason: 'missing-skill-name' };
  }

  // When no policy is configured, grandfathered behavior allows all skills.
  if (!ctx.policy) {
    return { allowed: true, skillName };
  }

  // Owners and admins can invoke any skill.
  if (ctx.isAdminOrOwner) {
    return { allowed: true, skillName };
  }

  const allowlist = new Set(
    (ctx.policy.skillAllowlist ?? [])
      .map(normalizeSkillName)
      .filter((n): n is string => n !== undefined),
  );

  if (allowlist.has(skillName)) {
    return { allowed: true, skillName };
  }

  return { allowed: false, reason: 'skill-not-allowed', skillName };
}
