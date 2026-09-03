#!/usr/bin/env node
// Entry bundled separately: upstream's .ts imports must not enter the server tsc graph.
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runAdd, parseAddOptions } from '../src/server/vendor/vercel-skills/src/add.ts';
import { getInstallPath } from '../src/server/vendor/vercel-skills/src/installer.ts';
import { getSkillLockPath } from '../src/server/vendor/vercel-skills/src/skill-lock.ts';
import type { AgentType } from '../src/server/vendor/vercel-skills/src/types.ts';
import { discoverInstalledSkills } from '../src/server/services/skill-inventory.js';
import { searchSkillsAPI } from '../src/server/services/skills/search.js';
import { getPrimaryHomeDir } from '../src/server/utils/home-dir.js';

const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
function take(args: string[], flag: string) {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  args.splice(at, 2);
  return value;
}
function flag(args: string[], name: string) {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

/** Resolve existing parents without following the final installation symlink. */
async function installationPath(target: string): Promise<string> {
  const parent = path.dirname(target);
  if (parent === target) return target;
  const canonicalParent = await realpath(parent).catch(() => installationPath(parent));
  return path.join(canonicalParent, path.basename(target));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('comate skills: inventory | find <query> | add <source> --project|--global --skill <names...> --agent <claude-code|codex|opencode...> | remove --path <path> --real-path <path> [--allow-shared]\nUse add --list to inspect a source. Updates use add with --replace --expected-path <path>, one installation at a time. Bundled Skills CLI 1.5.11; Git must be available for Git sources.'); return;
  }
  if (command === '--version') { console.log('comate-skills/1.5.11'); return; }
  if (command === 'inventory') {
    if (args.length) throw new Error('inventory uses the current working directory; no path override');
    const skills = await discoverInstalledSkills(process.cwd());
    const allowed = process.env.COMATE_BUILTIN_SKILLS?.split(',');
    print({ skills: skills.filter(s => (process.env.COMATE_SKILL_ISOLATED !== '1' || s.scope !== 'global') && (s.scope !== 'builtin' || !allowed || allowed.includes(s.name))) }); return;
  }
  if (command === 'find') {
    if (!args.join(' ').trim()) throw new Error('find requires a search query');
    print({ skills: await searchSkillsAPI(args.join(' ')), provider: 'skills.sh', status: 'available' }); return;
  }
  if (command === 'remove') {
    const selected = take(args, '--path');
    const expected = take(args, '--real-path');
    const allowShared = flag(args, '--allow-shared');
    if (!selected || !expected || args.length || !path.isAbsolute(selected)) throw new Error('remove requires --path and --real-path from inventory');
    const target = path.join(await realpath(path.dirname(selected)), path.basename(selected));
    const skill = (await discoverInstalledSkills(process.cwd())).find(s => s.installPath === target || s.aliases.includes(target));
    if (!skill || skill.scope === 'builtin' || (skill.scope === 'global' && process.env.COMATE_SKILL_ISOLATED === '1')) throw new Error('Select an installed user Skill; Comate maintains bundled Skills');
    if (await realpath(target) !== path.resolve(expected)) throw new Error('The installation target changed; inspect inventory again');
    const link = (await lstat(target)).isSymbolicLink();
    if (!link && skill.aliases.length && !allowShared) throw new Error('This directory has shared aliases; explain all affected paths before using --allow-shared');
    await rm(target, { recursive: !link });
    print({ status: 'removed', path: target, preservedTarget: link ? skill.realPath : undefined }); return;
  }
  if (command !== 'add') throw new Error(`Unknown command: ${command}`);
  const project = flag(args, '--project');
  const replace = flag(args, '--replace');
  const allowShared = flag(args, '--allow-shared');
  const expectedPath = take(args, '--expected-path');
  const parsed = parseAddOptions(args);
  const { options, source } = parsed;
  if (source.length !== 1) throw new Error('Provide one source');
  if (!options.list) {
    if (project === Boolean(options.global) || !options.skill?.length || !options.agent?.length || options.all || options.skill.includes('*')) throw new Error('Specify exactly one scope (--project or --global), selected --skill names and --agent targets');
    if (process.env.COMATE_SKILL_ISOLATED === '1' && options.global) throw new Error('This isolated session cannot manage user-level Skills');
    if (options.agent.some(a => !['claude-code', 'codex', 'opencode'].includes(a))) throw new Error('Supported targets: claude-code, codex, opencode');
    const targets = [...new Set(options.skill.flatMap(name => options.agent!.map(agent => getInstallPath(name, agent as AgentType, { global: options.global, cwd: process.cwd() }))))];
    if (replace && (targets.length !== 1 || !expectedPath || await installationPath(path.resolve(expectedPath)) !== await installationPath(targets[0]))) throw new Error('Replace one installation at a time with its exact --expected-path');
    const before = await discoverInstalledSkills(process.cwd());
    for (const target of targets) {
      const existing = await lstat(target).catch(() => undefined);
      if (existing && (!replace || existing.isSymbolicLink())) throw new Error(`Existing installation: ${target}. Inspect local changes and aliases before replacing; symlinks must be managed separately.`);
      const canonical = await installationPath(target);
      const installed = before.find(skill => skill.realPath === canonical);
      if (installed?.scope === 'builtin') throw new Error('Comate maintains bundled Skills');
      if (installed && [installed.installPath, ...installed.aliases].some(alias => alias !== canonical) && !allowShared) {
        throw new Error('This installation has shared aliases; explain all affected paths before using --allow-shared');
      }
      // A symlinked agent root changes the actual installation scope. Require
      // the same explicit shared-path acknowledgement even for a new Skill.
      const scopeBase = options.global ? getPrimaryHomeDir() : process.cwd();
      if (!allowShared && canonical !== path.join(await realpath(scopeBase), path.relative(scopeBase, target))) {
        throw new Error('The installation parent is shared through a symlink; inspect its scope before using --allow-shared');
      }
    }
    const lock = options.global ? getSkillLockPath() : path.join(process.cwd(), 'skills-lock.json');
    if (existsSync(lock)) {
      const data = JSON.parse(await readFile(lock, 'utf8'));
      if (data.version !== (options.global ? 3 : 1) || !data.skills || Array.isArray(data.skills)) throw new Error(`Unsupported lock format; preserving ${lock}. Use the repository installation instructions.`);
    }
    await runAdd(source, { ...options, yes: true, copy: true });
    const installed = await discoverInstalledSkills(process.cwd());
    const results = await Promise.all(targets.map(async target => {
      const canonical = await installationPath(target);
      return { path: target, status: !process.exitCode && installed.some(s => s.realPath === canonical) ? 'installed' : 'failed' };
    }));
    print({ results });
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
  } else await runAdd(source, { ...options, yes: true });
}
void main().catch(error => { process.stderr.write(`comate skills: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
