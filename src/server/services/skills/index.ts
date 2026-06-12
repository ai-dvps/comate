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
export { searchSkillsAPI } from './search.js';

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
  DiscoveredSkill,
} from './types.js';
