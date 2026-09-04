import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackendId } from './agent-backends.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPrimaryHomeDir } from '../utils/home-dir.js';
import { discoverInstalledSkills, type SkillInstallation } from './skill-inventory.js';

export function permittedSkills<T extends Pick<SkillInstallation, 'name' | 'scope' | 'backends'>>(skills: T[], backend: BackendId, options: Options): T[] {
  const builtinNames = options.env?.COMATE_BUILTIN_SKILLS?.split(',');
  const settings = typeof options.settings === 'object' ? options.settings : undefined;
  const restricted = [...(settings?.permissions?.deny ?? []), ...(settings?.permissions?.ask ?? [])];
  if (backend === 'claude') {
    const sources = options.settingSources ?? ['user', 'project', 'local'];
    const files = [
      ...(sources.includes('user') ? [path.join(options.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(getPrimaryHomeDir(), '.claude'), 'settings.json')] : []),
      ...(sources.includes('project') && options.cwd ? [path.join(options.cwd, '.claude/settings.json')] : []),
      ...(sources.includes('local') && options.cwd ? [path.join(options.cwd, '.claude/settings.local.json')] : []),
      ...(typeof options.settings === 'string' ? [options.settings] : []),
    ];
    for (const file of files) {
      try {
        const permissions = JSON.parse(readFileSync(file, 'utf8'))?.permissions;
        for (const rules of [permissions?.deny, permissions?.ask]) {
          if (Array.isArray(rules)) restricted.push(...rules.filter((rule): rule is string => typeof rule === 'string'));
        }
      } catch { /* Missing settings contribute no rules; native validation owns malformed settings. */ }
    }
  }
  const blocks = (name: string) => restricted.some(rule => {
    if (rule === 'Skill') return true;
    const pattern = /^Skill\((.*)\)$/.exec(rule)?.[1];
    return pattern !== undefined && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
  });
  return skills.filter((skill) => skill.backends.includes(backend)
    && (skill.scope !== 'builtin' || !builtinNames || builtinNames.includes(skill.name))
    && !(options.settingSources?.length === 0 && skill.scope === 'global')
    && (!Array.isArray(options.skills) || options.skills.includes(skill.name))
    && !options.disallowedTools?.includes('Skill')
    && !blocks(skill.name));
}

/** Resolve explicit references on each turn, so filesystem changes do not require a stale name cache. */
export async function* withSkillReferences(input: AsyncIterable<SDKUserMessage>, options: Options, backend: BackendId): AsyncGenerator<SDKUserMessage> {
  for await (const message of input) {
    const content = message.message.content;
    const texts = typeof content === 'string' ? [content] : content.flatMap(block => block.type === 'text' ? [block.text] : []);
    if (!texts.some(text => /(^|\s)\/\S+/.test(text))) { yield message; continue; }
    const skills = permittedSkills(await discoverInstalledSkills(options.cwd), backend, options);
    const byName = new Map<string, SkillInstallation>();
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    for (const skill of skills) {
      if (counts.get(skill.name) === 1) byName.set(skill.name, skill);
    }
    const expand = (text: string) => text.replace(/(^|\s)\/(\S+)/g, (match, prefix: string, name: string) => {
      const skill = byName.get(name);
      if (!skill) return match;
      return `${prefix}Use the selected Skill ${JSON.stringify(skill.name)}: read ${JSON.stringify(`${skill.installPath}/SKILL.md`)} and resolve its references relative to that directory. Follow the user's scope and existing permissions.\n`;
    });
    yield { ...message, message: { ...message.message, content: typeof content === 'string'
      ? expand(content)
      : content.map((block) => block.type === 'text' ? { ...block, text: expand(block.text) } : block) } };
  }
}
