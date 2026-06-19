import type { WeComBotIsolationSettings } from '../models/workspace.js';

export interface SkillPolicyContext {
  isolation: WeComBotIsolationSettings | undefined;
  isAdmin: boolean;
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

  // When isolation is not configured, grandfathered behavior allows all skills.
  if (!ctx.isolation) {
    return { allowed: true, skillName };
  }

  const defaultSet = new Set(
    (ctx.isolation.defaultAllowedSkills ?? [])
      .map(normalizeSkillName)
      .filter((n): n is string => n !== undefined),
  );
  const adminSet = new Set(
    (ctx.isolation.adminAllowedSkills ?? [])
      .map(normalizeSkillName)
      .filter((n): n is string => n !== undefined),
  );

  if (defaultSet.has(skillName)) {
    return { allowed: true, skillName };
  }

  if (ctx.isAdmin && adminSet.has(skillName)) {
    return { allowed: true, skillName };
  }

  return { allowed: false, reason: 'skill-not-allowed', skillName };
}
