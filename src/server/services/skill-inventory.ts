import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPrimaryHomeDir } from '../utils/home-dir.js';
import { parseSkillMd } from './skills/skills-discovery.js';
import { builtinSkillRoots, isBuiltinSkillFile } from './builtin-skills.js';
import type { BackendId } from './agent-backends.js';

import type { SkillInstallation } from '../../shared/skill-types.js';
export type { SkillInstallation } from '../../shared/skill-types.js';

interface SkillRoot { path: string; scope: SkillInstallation['scope']; backends: BackendId[] }
const ALL: BackendId[] = ['claude', 'codex', 'opencode'];

export function skillRoots(workspace?: string, home = getPrimaryHomeDir(), config = process.env.XDG_CONFIG_HOME || path.join(home, '.config')): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const add = (base: string, scope: SkillRoot['scope'], relative: string, backends: BackendId[]) => roots.push({ path: path.join(base, relative), scope, backends });
  for (const [base, scope] of [[workspace, 'project'], [home, 'global']] as const) {
    if (!base) continue;
    add(base, scope, '.claude/skills', ALL);
    add(base, scope, '.agents/skills', ['codex', 'opencode']);
    if (scope === 'project') {
      add(base, scope, '.opencode/skills', ['opencode']);
      add(base, scope, '.opencode/skill', ['opencode']);
    }
  }
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) add(process.env.CLAUDE_CONFIG_DIR.trim(), 'global', 'skills', ['claude']);
  add(process.env.CODEX_HOME || path.join(home, '.codex'), 'global', 'skills', ['codex']);
  add(config, 'global', 'opencode/skills', ['opencode']);
  add(config, 'global', 'opencode/skill', ['opencode']);
  for (const builtin of builtinSkillRoots()) roots.push({ path: builtin, scope: 'builtin', backends: ALL });
  return roots;
}

async function lockEntries(file: string): Promise<Record<string, { source?: string; packageSlug?: string; packageCatalog?: { summary?: string } }>> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data.skills === 'object' && !Array.isArray(data.skills) ? data.skills ?? {} : {};
  } catch { return {}; }
}

/** The filesystem owns existence. Lock records only enrich known installations. */
export async function discoverInstalledSkills(workspace?: string, home = getPrimaryHomeDir()): Promise<SkillInstallation[]> {
  const records = new Map<string, SkillInstallation>();
  const recordedSources = new Set<string>();
  const [projectLock, globalLock] = await Promise.all([
    workspace ? lockEntries(path.join(workspace, 'skills-lock.json')) : lockEntries(''),
    lockEntries(process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : path.join(home, '.agents', '.skill-lock.json')),
  ]);
  for (const root of skillRoots(workspace, home)) {
    const visited = new Set<string>();
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 12) return;
      let canonical: string;
      try { canonical = await realpath(directory); } catch { return; }
      if (visited.has(canonical)) {
        const existing = records.get(canonical);
        if (existing && directory !== existing.installPath && !existing.aliases.includes(directory)) existing.aliases.push(directory);
        return;
      }
      visited.add(canonical);
      const lock = root.scope === 'project' ? projectLock : globalLock;
      const entry = root.scope === 'builtin' ? undefined : lock[path.basename(directory)];
      let skill: { name: string; description: string; metadata?: Record<string, unknown> } | null = await parseSkillMd(path.join(directory, 'SKILL.md'), { includeInternal: true });
      // Older expert packages stored an orchestration document without frontmatter.
      // A lock entry can describe that actual file, but must never resurrect it.
      if (!skill && entry?.source?.startsWith('skillhub-package:') && (await stat(path.join(directory, 'SKILL.md')).catch(() => undefined))?.isFile()) {
        skill = { name: path.basename(directory), description: typeof entry.packageCatalog?.summary === 'string' ? entry.packageCatalog.summary : 'Expert package orchestration' };
      }
      if (skill) {
        const existing = records.get(canonical);
        if (existing) {
          if (directory !== existing.installPath && !existing.aliases.includes(directory)) existing.aliases.push(directory);
          existing.backends = [...new Set([...existing.backends, ...root.backends])];
          return;
        }
        const appOwned = isBuiltinSkillFile(path.join(directory, 'SKILL.md'));
        const provenance = await readFile(path.join(directory, '.comate-skill-source.json'), 'utf8')
          .then(text => JSON.parse(text) as { source?: unknown }).catch(() => undefined);
        const localSource = typeof provenance?.source === 'string' ? provenance.source : '';
        if (localSource) recordedSources.add(canonical);
        const source = appOwned ? 'Comate' : localSource || (typeof entry?.source === 'string' ? entry.source : '');
        const id = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
        records.set(canonical, {
          id, name: skill.name, description: skill.description,
          ...(typeof skill.metadata?.version === 'string' && skill.metadata.version.trim() ? { version: skill.metadata.version.trim() } : {}),
          scope: appOwned ? 'builtin' : root.scope, source,
          installPath: directory, realPath: canonical, aliases: [], backends: [...root.backends],
          isLegacySymlink: (await lstat(directory).catch(() => undefined))?.isSymbolicLink() ?? false,
          kind: source.startsWith('skillhub-package:') ? 'expert-package-orchestrator' : 'skill',
          ...(entry?.packageSlug ? { packageSlug: entry.packageSlug } : {}),
          invocationName: skill.name,
        });
        return;
      }
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) await visit(path.join(directory, entry.name), depth + 1);
      }
    };
    await visit(root.path, 0);
  }
  const skills = [...records.values()];
  const nameCounts = new Map<string, number>();
  for (const skill of skills) {
    const key = `${skill.scope}:${skill.name}`;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  for (const skill of skills) {
    // Legacy locks key by name, so they cannot identify two independent copies
    // of that name in one scope. Do not present ambiguous provenance as fact.
    if (skill.scope !== 'builtin' && !recordedSources.has(skill.realPath) && (nameCounts.get(`${skill.scope}:${skill.name}`) ?? 0) > 1) skill.source = '';
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function skillCommands(skills: SkillInstallation[], backend: BackendId) {
  return skills.filter((skill) => skill.backends.includes(backend)).map((skill) => ({
    name: skill.invocationName,
    displayName: skill.name,
    description: `${skill.description} (${skill.scope}: ${skill.installPath})`,
    skillPath: path.join(skill.realPath, 'SKILL.md'),
  }));
}
