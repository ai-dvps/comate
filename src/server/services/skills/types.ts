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
  /** Stable API identifier used by the client as its result key. */
  id: string;
  name: string;
  /**
   * Legacy skills.sh identifier retained for callers of the existing search
   * endpoint. GitHub repository results use their owner/repository name.
   */
  slug: string;
  source: string;
  /** Source reference passed to the existing resolver and installer. */
  installSource: string;
  /** Registry that returned this result. */
  sourceKind: SkillSearchProviderId;
  description: string;
  installs: number;
  /** Optional provider timestamp in milliseconds, used by the newest sort. */
  updatedAt?: number;
}

export const SKILL_SEARCH_PROVIDER_IDS = [
  'skills.sh',
  'skillshub',
  'xfyun',
  'skillhub-cn',
  'weskillhub',
] as const;

export type SkillSearchProviderId = (typeof SKILL_SEARCH_PROVIDER_IDS)[number];
export type SkillProviderFailureReason = 'network' | 'timeout' | 'http' | 'invalid-response';

export interface SkillProviderAvailability {
  id: SkillSearchProviderId;
  label: string;
  status: 'available' | 'unavailable';
  reason?: SkillProviderFailureReason;
}

export interface FederatedSkillSearchResult {
  skills: SearchSkill[];
  providers: SkillProviderAvailability[];
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
  /** Expert Package that installed this Skill, when applicable. */
  packageSlug?: string;
  /** Catalog summary saved with an Expert Package orchestration for offline display. */
  packageCatalog?: ExpertPackageSummary;
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
  /** Expert Package that installed this Skill, when applicable. */
  packageSlug?: string;
  /** Catalog summary saved with an Expert Package orchestration for offline display. */
  packageCatalog?: ExpertPackageSummary;
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
  /** Product classification. Package orchestration is runtime-compatible but not a catalog Skill. */
  kind?: 'skill' | 'expert-package-orchestrator';
  status: 'installed' | 'already-installed' | 'error';
  path?: string;
  error?: string;
}

export type InstalledSkillKind = 'skill' | 'expert-package-orchestrator';

export interface ExpertPackageSummary {
  slug: string;
  displayName: string;
  displayNameEn?: string;
  summary: string;
  summaryEn?: string;
  scene: string;
  subScene?: string;
  skillCount: number;
  source: 'skillhub.cn';
}

export interface ExpertPackageChild {
  namespace: string;
  slug: string;
  displayName: string;
  summary: string;
  available: boolean;
  source: string;
  securityReports?: ExpertSkillSecurityReport[];
}

export interface ExpertPackageDetail extends ExpertPackageSummary {
  content: string;
  contentEn?: string;
  children: ExpertPackageChild[];
  complete: boolean;
  unavailableReason?: string;
}

export interface SkillHubSecurityReport {
  provider: string;
  status: string;
  statusText: string;
  reportUrl?: string;
}

export interface SkillHubSkillDetail {
  namespace: string;
  slug: string;
  displayName: string;
  summary: string;
  category: string;
  owner: { handle: string; displayName: string };
  /** Stable enterprise publisher identity used for server-side membership checks. */
  publisher?: { orgId: string };
  version: string;
  stats: { downloads: number; installs: number };
  securityReports: SkillHubSecurityReport[];
  /** Raw, validated SKILL.md from the same registry coordinate. */
  documentation?: string;
  source: string;
}

export interface EnterpriseIndustry {
  key: string;
  displayName: string;
  displayNameEn?: string;
  sortOrder: number;
}

export interface EnterpriseSummary {
  orgId: string;
  name: string;
  fullName?: string;
  shortName?: string;
  description: string;
  industryTags: string[];
  logoUrl?: string;
  publishedSkillCount: number;
  totalDownloads: number;
}

export interface EnterpriseDetail extends EnterpriseSummary {
  totalStars: number;
}

export type EnterpriseSkillSort = 'downloads' | 'stars' | 'latest';

export interface EnterpriseSkillSummary {
  namespace: string;
  slug: string;
  displayName: string;
  summary: string;
  downloads: number;
  stars: number;
  iconUrl?: string;
}

export interface EnterprisePage {
  enterprises: EnterpriseSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface EnterpriseSkillPage {
  skills: EnterpriseSkillSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** Compatibility names retained for the existing Expert Package API. */
export type ExpertSkillSecurityReport = SkillHubSecurityReport;
export type ExpertSkillDetail = SkillHubSkillDetail;

export type ExpertPackageInstallItemKind = 'orchestrator' | 'skill';

export interface ExpertPackageInstallResult {
  /** Stable retry identity owned by the canonical package definition. */
  id: string;
  kind: ExpertPackageInstallItemKind;
  source: string;
  name: string;
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
