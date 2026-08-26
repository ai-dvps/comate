import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const WORKSPACE_SKILL_ROOTS = [
  '.opencode/skill',
  '.opencode/skills',
  '.claude/skills',
  '.agents/skills',
] as const;

async function collectSkillFiles(
  workspace: string,
  directory: string,
  records: string[],
  visited: Set<string>,
): Promise<void> {
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    records.push(`error:${relative(workspace, directory)}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
    return;
  }
  if (visited.has(canonicalDirectory)) return;
  visited.add(canonicalDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    records.push(`error:${relative(workspace, directory)}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(workspace, path, records, visited);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if ((await stat(path)).isDirectory()) {
          await collectSkillFiles(workspace, path, records, visited);
          continue;
        }
      } catch (error) {
        records.push(`error:${relative(workspace, path)}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
        continue;
      }
    }
    if (entry.name !== 'SKILL.md') continue;
    try {
      const content = await readFile(path);
      records.push(`${relative(workspace, path)}:${createHash('sha256').update(content).digest('hex')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        records.push(`error:${relative(workspace, path)}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
      }
    }
  }
}

/** Content snapshot for the project-local skill roots OpenCode discovers. */
export async function getWorkspaceSkillSnapshot(workspace: string): Promise<string> {
  const records: string[] = [];
  const visited = new Set<string>();
  for (const root of WORKSPACE_SKILL_ROOTS) {
    await collectSkillFiles(workspace, join(workspace, root), records, visited);
  }
  records.sort();
  return createHash('sha256').update(records.join('\n')).digest('hex');
}
