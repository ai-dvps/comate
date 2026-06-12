/**
 * SKILL.md container-path discovery.
 *
 * Reimplemented from `src/server/vendor/vercel-skills/src/skills.ts`.
 * Upstream uses `.ts` extension imports and pulls in `plugin-manifest.ts`
 * (which itself imports clack deps); we port only the discovery logic and
 * drop plugin-grouping awareness — Comate treats plugin-bundled skills as
 * Plugin Manager territory (per scope boundary in the plan).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, dirname, basename, relative, sep } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { sanitizeMetadata } from './sanitize.js';
import { isSubpathSafe } from './source-resolver.js';
import type { Skill, DiscoveredSkill } from './types.js';

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__'];

/**
 * Returns true if an `internal: true` SKILL.md should be included.
 * Mirrors upstream env-gated behavior. Defaults to false — internal skills
 * are hidden unless explicitly requested.
 */
function shouldInstallInternalSkills(): boolean {
  const envValue = process.env.INSTALL_INTERNAL_SKILLS;
  return envValue === '1' || envValue === 'true';
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    const skillPath = join(dir, 'SKILL.md');
    const stats = await stat(skillPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Parse a SKILL.md file and return its metadata.
 * Returns null if the file is missing required frontmatter fields
 * (`name` and `description`) or is marked internal without override.
 */
export async function parseSkillMd(
  skillMdPath: string,
  options?: { includeInternal?: boolean }
): Promise<Skill | null> {
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const { data } = parseFrontmatter(content);

    if (!data.name || !data.description) {
      return null;
    }

    if (typeof data.name !== 'string' || typeof data.description !== 'string') {
      return null;
    }

    const isInternal = data.metadata && typeof data.metadata === 'object' && (data.metadata as { internal?: unknown }).internal === true;
    if (isInternal && !shouldInstallInternalSkills() && !options?.includeInternal) {
      return null;
    }

    return {
      name: sanitizeMetadata(data.name),
      description: sanitizeMetadata(data.description),
      path: dirname(skillMdPath),
      rawContent: content,
      metadata: data.metadata && typeof data.metadata === 'object'
        ? data.metadata as Record<string, unknown>
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Recursively find all directories containing a `SKILL.md` file.
 * Bounded at `maxDepth` to prevent runaway traversal of huge repos.
 */
async function findSkillDirs(dir: string, depth = 0, maxDepth = 5): Promise<string[]> {
  if (depth > maxDepth) return [];

  try {
    const [hasSkill, entries] = await Promise.all([
      hasSkillMd(dir),
      readdir(dir, { withFileTypes: true }).catch(() => []),
    ]);

    const currentDir = hasSkill ? [dir] : [];

    const subDirResults = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.includes(entry.name))
        .map((entry) => findSkillDirs(join(dir, entry.name), depth + 1, maxDepth))
    );

    return [...currentDir, ...subDirResults.flat()];
  } catch {
    return [];
  }
}

/**
 * Options controlling skill discovery.
 */
export interface DiscoverSkillsOptions {
  /** Include internal skills (e.g., when user explicitly requests by name) */
  includeInternal?: boolean;
  /** Search all subdirectories even when a root SKILL.md exists */
  fullDepth?: boolean;
  /** Optional skill filter (from `owner/repo@skill-name` syntax) */
  skillFilter?: string;
}

/**
 * Discover all skills in a cloned/local repository.
 *
 * Walks `basePath` (or `basePath/subpath` if given) recursively, finds every
 * directory containing a `SKILL.md` file, parses its frontmatter, and returns
 * the list. Skills with duplicate names are deduped (first occurrence wins).
 *
 * If `skillFilter` is provided, only skills whose name (sanitized to lowercase
 * kebab-case) matches are returned.
 *
 * @throws if `subpath` resolves outside `basePath` (path traversal defense)
 */
export async function discoverSkills(
  basePath: string,
  subpath?: string,
  options?: DiscoverSkillsOptions
): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seenNames = new Set<string>();

  if (subpath && !isSubpathSafe(basePath, subpath)) {
    throw new Error(
      `Invalid subpath: "${subpath}" resolves outside the repository directory. ` +
        `Subpath must not contain ".." segments that escape the base path.`
    );
  }

  const searchPath = subpath ? join(basePath, subpath) : basePath;

  // If pointing directly at a skill, return it (unless fullDepth is set).
  if (await hasSkillMd(searchPath)) {
    const skill = await parseSkillMd(join(searchPath, 'SKILL.md'), options);
    if (skill) {
      skills.push(skill);
      seenNames.add(skill.name);
      if (!options?.fullDepth) {
        return filterSkills(skills, options?.skillFilter);
      }
    }
  }

  // Otherwise walk the tree.
  const allDirs = await findSkillDirs(searchPath);
  for (const dir of allDirs) {
    const skill = await parseSkillMd(join(dir, 'SKILL.md'), options);
    if (!skill) continue;
    if (seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    skills.push(skill);
  }

  return filterSkills(skills, options?.skillFilter);
}

function filterSkills(skills: Skill[], skillFilter?: string): Skill[] {
  if (!skillFilter) return skills;
  const normalized = skillFilter.toLowerCase().replace(/[\s_]+/g, '-');
  return skills.filter((skill) => {
    const nameMatch = skill.name.toLowerCase().replace(/[\s_]+/g, '-') === normalized;
    const dirMatch = basename(skill.path).toLowerCase().replace(/[\s_]+/g, '-') === normalized;
    return nameMatch || dirMatch;
  });
}

/**
 * Convert an internal `Skill` (absolute paths) into the wire-format
 * `DiscoveredSkill` (paths relative to the source root) that the client
 * and SkillsService expect.
 */
export function toDiscoveredSkill(skill: Skill, sourceRoot: string): DiscoveredSkill {
  let rel = relative(sourceRoot, skill.path).split(sep).join('/');
  if (rel === '') rel = '.';
  return {
    name: skill.name,
    description: skill.description,
    relativePath: rel,
    pluginName: skill.pluginName,
  };
}
