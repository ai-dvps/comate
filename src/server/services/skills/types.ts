/**
 * Comate-owned type definitions for the Skills adapter layer.
 *
 * These mirror the upstream `vercel-labs/skills` types at
 * `src/server/vendor/vercel-skills/src/types.ts` but live in our codebase.
 * We do not import from the vendored tree because upstream modules use
 * `.ts` extension imports (`'./types.ts'`) that are incompatible with
 * our tsc emit settings, and several upstream modules pull in
 * `@clack/prompts`, `picocolors`, or `telemetry.ts` at module top level.
 *
 * Keep these in sync with upstream when subtree-pulling — the adapter
 * uses vendored source as a SPEC REFERENCE only.
 */

/**
 * Result of parsing a source string (URL, owner/repo shorthand, local path).
 * Mirrors upstream `ParsedSource`.
 */
export interface ParsedSource {
  type: 'github' | 'gitlab' | 'git' | 'local' | 'well-known';
  url: string;
  subpath?: string;
  localPath?: string;
  ref?: string;
  /** Skill name extracted from @skill syntax (e.g., owner/repo@skill-name) */
  skillFilter?: string;
}

/**
 * A single skill discovered in a source repository or returned by the
 * skills.sh search API. Mirrors upstream `Skill` + `SearchSkill`.
 */
export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the skill directory (containing SKILL.md) */
  path: string;
  /** Raw SKILL.md content for hashing / display */
  rawContent?: string;
  /** Name of the plugin this skill belongs to (if any) */
  pluginName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Skill returned by the skills.sh `/api/search` endpoint.
 * Mirrors upstream `SearchSkill`.
 */
export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

/**
 * The shape of a skill entry in the project lock file (`<workspace>/skills-lock.json`).
 * Mirrors upstream `LocalSkillLockEntry` (version 1 schema).
 */
export interface LocalSkillLockEntry {
  source: string;
  ref?: string;
  sourceType: string;
  /** Path to the skill's SKILL.md within the source repo */
  skillPath?: string;
  /** SHA-256 hash computed from local files */
  computedHash: string;
}

export interface LocalSkillLockFile {
  version: number;
  skills: Record<string, LocalSkillLockEntry>;
}

/**
 * The shape of a skill entry in the global lock file (`~/.agents/.skill-lock.json`).
 * Mirrors upstream `SkillLockEntry` (version 3 schema), minus the GitHub
 * tree-SHA machinery (we compute the hash locally instead).
 */
export interface GlobalSkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  /** SHA-256 hash computed from local files (replaces upstream GitHub tree SHA) */
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
  pluginName?: string;
}

export interface GlobalSkillLockFile {
  version: number;
  skills: Record<string, GlobalSkillLockEntry>;
  dismissed?: Record<string, boolean>;
  lastSelectedAgents?: string[];
}

/**
 * Scope of a skill install. Mirrors the Skills page UX (no `local` scope,
 * unlike the Plugin Manager).
 */
export type SkillScope = 'project' | 'global';

/**
 * Result returned by the installer for a single skill.
 */
export interface InstallResult {
  skillName: string;
  status: 'installed' | 'already-installed' | 'error';
  path?: string;
  error?: string;
}

/**
 * Result returned by the resolver when discovering skills at a source.
 */
export interface DiscoveredSkill {
  /** Sanitized display name from SKILL.md frontmatter */
  name: string;
  description: string;
  /** Relative path from the source root to the skill directory */
  relativePath: string;
  /** Optional plugin name if the skill is part of a plugin manifest */
  pluginName?: string;
}
