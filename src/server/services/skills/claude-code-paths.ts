/**
 * Hardcoded Claude Code skill paths.
 *
 * The upstream `vercel-labs/skills` package supports 70+ agents via
 * `agents.ts` + `detect-agent.ts`. Comate only ships for Claude Code,
 * so we drop the agent-detection machinery and hardcode the two paths
 * Claude Code actually reads.
 */

import { homedir } from 'os';
import { join } from 'path';

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
 * Mirrors the HOME-candidate resolution from `claude-settings.ts:48-58`:
 * prefer $USERPROFILE (Windows), then $HOME, then $HOMEDRIVE+$HOMEPATH,
 * finally `os.homedir()` as a fallback. This matters under Tauri where
 * env propagation may be incomplete.
 */
export function getGlobalSkillsDir(): string {
  const home = (
    process.env.USERPROFILE ||
    process.env.HOME ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined) ||
    homedir()
  );
  return join(home, GLOBAL_SKILLS_SUBDIR);
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
