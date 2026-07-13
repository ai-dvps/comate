/**
 * Hardcoded Claude Code skill paths.
 *
 * The upstream `vercel-labs/skills` package supports 70+ agents via
 * `agents.ts` + `detect-agent.ts`. Comate only ships for Claude Code,
 * so we drop the agent-detection machinery and hardcode the two paths
 * Claude Code actually reads.
 */

import { join } from 'path';

import { getPrimaryHomeDir } from '../../utils/home-dir.js';

/**
 * Project-scoped skills directory: `<workspace>/.claude/skills/`.
 * Trailing slash omitted; callers compose with `join()`.
 */
export const PROJECT_SKILLS_SUBDIR = '.claude/skills';

/**
 * Global-scoped skills directory: `~/.claude/skills/`.
 * Trailing slash omitted; callers compose with `join()`.
 */
export const GLOBAL_SKILLS_SUBDIR = '.claude/skills';

/**
 * Resolve the project-scoped skills directory for a workspace.
 */
export function getProjectSkillsDir(workspacePath: string): string {
  return join(workspacePath, PROJECT_SKILLS_SUBDIR);
}

/**
 * Resolve the global-scoped skills directory (`~/.claude/skills/`).
 *
 * Uses the shared home cascade from `src/server/utils/home-dir.ts`:
 * $USERPROFILE (Windows) → $HOME → $HOMEDRIVE+$HOMEPATH → `os.homedir()`.
 * This matters under Tauri where env propagation may be incomplete.
 */
export function getGlobalSkillsDir(): string {
  return join(getPrimaryHomeDir(), GLOBAL_SKILLS_SUBDIR);
}

/**
 * Resolve the skills directory for a given scope.
 */
export function getSkillsDirForScope(scope: 'project' | 'global', workspacePath?: string): string {
  if (scope === 'project') {
    if (!workspacePath) {
      throw new Error('workspacePath is required for project-scoped skills');
    }
    return getProjectSkillsDir(workspacePath);
  }
  return getGlobalSkillsDir();
}
