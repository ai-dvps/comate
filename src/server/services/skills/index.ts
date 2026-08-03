/**
 * Skills adapter — public re-exports.
 *
 * This module is the boundary between Comate code and the vendored
 * `vercel-labs/skills` source. Everything above this line (SkillsService,
 * routes, store) imports from here; everything below (vendored source at
 * `src/server/vendor/vercel-skills/`) is treated as a spec reference only.
 *
 * Re-export surface mirrors upstream's public API as closely as possible
 * (so future subtree-pulls surface drift at compile time).
 */

// Path constants
export {
  PROJECT_SKILLS_SUBDIR,
  GLOBAL_SKILLS_SUBDIR,
  getProjectSkillsDir,
  getGlobalSkillsDir,
  getSkillsDirForScope,
} from './claude-code-paths.js';

// Sanitization (escape sequence stripping)
export { stripTerminalEscapes, sanitizeMetadata } from './sanitize.js';

// skills.sh search
export {
  searchFederatedSkills,
  searchSkillsAPI,
  searchSkillsHubSkills,
  searchSkillhubCnSkills,
  searchXfyunSkills,
} from './search.js';
export {
  SKILL_SCENES,
  SCENE_LABELS,
  isSkillScene,
  isSkillSort,
} from './search-query.js';
export type { SkillScene, SkillSort, SkillSearchQuery } from './search-query.js';

export {
  getExpertPackage,
  getExpertPackageDefinition,
  getExpertSkill,
  listExpertPackages,
  ExpertPackageProviderError,
  EXPERT_PACKAGE_SCENES,
  isExpertPackageCoordinate,
  isExpertPackageScene,
  expertPackageLimits,
} from './expert-packages.js';
export type { ExpertPackageDefinition } from './expert-packages.js';
export {
  assertSkillHubCoordinate,
  fetchSkillHubJson,
  getSkillHubSkill,
  isSkillHubCoordinate,
  normalizeSkillHubHttpsUrl,
  normalizeSkillHubSecurityReports,
  skillHubLimits,
  skillHubNumber,
  SkillHubProviderError,
  skillHubRecord,
  skillHubSummary,
  skillHubText,
} from './skillhub.js';
export type { SkillHubErrorCode, SkillHubRecord } from './skillhub.js';
export {
  materializeRegistrySource,
  parseRegistrySource,
  registryArchiveLimits,
  registrySourceUrl,
  validateArchiveEntries,
} from './registry-source.js';
export type { RegistrySource, RegistrySourceKind } from './registry-source.js';
export { InstallCoordinator, installCoordinator } from './install-coordinator.js';

// Source string parsing
export {
  parseSource,
  sanitizeSubpath,
  assertLocalPathSafe,
  isSubpathSafe,
  getOwnerRepo,
} from './source-resolver.js';

// SKILL.md frontmatter + discovery
export { parseFrontmatter } from './frontmatter.js';
export {
  parseSkillMd,
  discoverSkills,
  toDiscoveredSkill,
} from './skills-discovery.js';

// Git clone wrapper
export { cloneRepository } from './git-adapter.js';

// Lock file schema + path resolution
export {
  PROJECT_LOCK_FILENAME,
  PROJECT_LOCK_CURRENT_VERSION,
  GLOBAL_LOCK_DIRNAME,
  GLOBAL_LOCK_FILENAME,
  GLOBAL_LOCK_CURRENT_VERSION,
  getProjectLockPath,
  getGlobalLockPath,
  readProjectLock,
  readGlobalLock,
  serializeProjectLock,
  serializeGlobalLock,
  buildProjectLockEntry,
  buildGlobalLockEntry,
} from './skill-lock-adapter.js';

// Installer (copy + remove + hash)
export {
  sanitizeName,
  copySkillToScope,
  removeSkillFromScope,
  computeSkillFolderHash,
} from './installer.js';

// Types
export type {
  ParsedSource,
  Skill,
  SearchSkill,
  LocalSkillLockEntry,
  LocalSkillLockFile,
  GlobalSkillLockEntry,
  GlobalSkillLockFile,
  SkillScope,
  InstallResult,
  InstalledSkillKind,
  ExpertPackageSummary,
  ExpertPackageChild,
  ExpertPackageDetail,
  ExpertSkillSecurityReport,
  ExpertSkillDetail,
  SkillHubSecurityReport,
  SkillHubSkillDetail,
  ExpertPackageInstallItemKind,
  ExpertPackageInstallResult,
  DiscoveredSkill,
} from './types.js';
