import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { SlashCommandDto } from '../types/initialization.js';
import { getPrimaryHomeDir } from '../utils/home-dir.js';
import { parseFrontmatter } from './command-fs-parser.js';

const WORKSPACE_SKILL_ROOTS = [
  '.opencode/skill',
  '.opencode/skills',
  '.claude/skills',
  '.agents/skills',
] as const;

function globalSkillRoots(homeDirectory: string, configDirectory: string): string[] {
  return [
    join(configDirectory, 'opencode/skill'),
    join(configDirectory, 'opencode/skills'),
    join(homeDirectory, '.claude/skills'),
    join(homeDirectory, '.agents/skills'),
  ];
}

async function collectSkillFiles(
  workspace: string,
  directory: string,
  records: string[],
  visited: Set<string>,
  skills?: SlashCommandDto[],
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
      await collectSkillFiles(workspace, path, records, visited, skills);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if ((await stat(path)).isDirectory()) {
          await collectSkillFiles(workspace, path, records, visited, skills);
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
      if (skills) {
        const frontmatter = parseFrontmatter(content.toString('utf8'));
        skills.push({
          name: basename(dirname(path)),
          description: frontmatter.description ?? '',
          argumentHint: frontmatter.argumentHint,
          aliases: frontmatter.aliases,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        records.push(`error:${relative(workspace, path)}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
      }
    }
  }
}

/** Skills available before an OpenCode session runtime exists. */
export async function getAvailableSkills(
  workspace: string,
  homeDirectory = getPrimaryHomeDir(),
  configDirectory = process.env.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config'),
): Promise<SlashCommandDto[]> {
  const records: string[] = [];
  const skills: SlashCommandDto[] = [];
  const visited = new Set<string>();
  for (const root of WORKSPACE_SKILL_ROOTS) {
    await collectSkillFiles(workspace, join(workspace, root), records, visited, skills);
  }
  for (const root of globalSkillRoots(homeDirectory, configDirectory)) {
    await collectSkillFiles(homeDirectory, root, records, visited, skills);
  }

  const unique = new Map<string, SlashCommandDto>();
  for (const skill of skills) {
    if (!unique.has(skill.name)) unique.set(skill.name, skill);
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
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
