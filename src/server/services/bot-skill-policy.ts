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

/**
 * Send-capable wecom skills are NOT restricted by the bot-level skill config
 * (KTD-14, session-settled): they are the bot's reply path, so they always
 * mount and can never be deny-listed. Both the plain SKILL.md name and the
 * `wecom:` plugin-qualified form are covered at every layer.
 */
export const UNRESTRICTED_SKILLS: ReadonlyArray<string> = [
  'send-wecom-msg',
  'send-wecom-file',
  'wecom-doc',
];

/** Normalized lookup set: plain + plugin-qualified forms of UNRESTRICTED_SKILLS. */
const UNRESTRICTED_NORMALIZED: ReadonlySet<string> = new Set(
  UNRESTRICTED_SKILLS.flatMap((name) => [name, `wecom:${name}`]),
);

function isUnrestrictedSkill(normalizedName: string): boolean {
  return UNRESTRICTED_NORMALIZED.has(normalizedName);
}

/**
 * Compile the bot-level mounted set into the SDK skill context filter
 * (`Options.skills`, U5/R8): the configured closed set plus the unrestricted
 * send-capable wecom skills in both plain and plugin-qualified forms
 * (KTD-14). Configured entries are kept verbatim — the SDK matches exact
 * SKILL.md `name` / directory names / `plugin:skill` identifiers. This is a
 * context filter, not a sandbox: unlisted skills are hidden from the model
 * and rejected by the Skill tool, but their files remain reachable.
 */
export function compileSkillFilter(mountedSkills: string[]): string[] {
  const out = new Set<string>();
  for (const entry of mountedSkills) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (trimmed !== '') out.add(trimmed);
  }
  for (const name of UNRESTRICTED_SKILLS) {
    out.add(name);
    out.add(`wecom:${name}`);
  }
  return [...out];
}

/**
 * Compile the bot-level disabled list into explicit SDK deny rules (U5,
 * KTD-14 backstop): deny evaluates before allow/canUseTool in the permission
 * pipeline, so a disabled skill stays blocked even when it is also mounted
 * (deny takes precedence over mount). Names are normalized to the same
 * kebab-case form the gate uses so the two layers agree; unrestricted
 * send-capable skills can never be deny-listed.
 */
export function compileSkillDenyRules(disabledSkills: string[]): string[] {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const entry of disabledSkills) {
    const name = normalizeSkillName(entry);
    if (!name || seen.has(name) || isUnrestrictedSkill(name)) continue;
    seen.add(name);
    rules.push(`Skill(${name})`);
  }
  return rules;
}


function extractSkillName(input: Record<string, unknown>): string | undefined {
  return (
    normalizeSkillName(input.skill_name) ??
    normalizeSkillName(input.name) ??
    normalizeSkillName(input.skill)
  );
}

/**
 * Bot-level disabled-skill check for the sandbox permission model (U3,
 * R8/KTD-14): per-role allowlists are gone; the mounted skill set is a
 * bot-level capability enforced through the SDK context filter (U5) and
 * individual disables go through the explicit `disabledSkills` deny list.
 * This gate check is the in-gate backstop for the compiled deny rules.
 * Send-capable wecom skills are unrestricted (KTD-14) and never disabled.
 * Returns the normalized skill name so the caller can audit.
 */
export function evaluateSkillDisabled(
  disabledSkills: string[],
  input: Record<string, unknown>,
): { disabled: boolean; skillName?: string } {
  const skillName = extractSkillName(input);
  if (!skillName) return { disabled: false };
  if (isUnrestrictedSkill(skillName)) return { disabled: false, skillName };
  const disabled = new Set(
    disabledSkills.map(normalizeSkillName).filter((n): n is string => n !== undefined),
  );
  return { disabled: disabled.has(skillName), skillName };
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
