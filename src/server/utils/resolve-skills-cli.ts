import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveComateCliPath } from './resolve-comate-cli.js';

export function resolveSkillsCliPath(): string | undefined {
  const comate = resolveComateCliPath();
  if (comate && process.env.TAURI_RESOURCE_DIR) {
    const candidate = path.resolve(path.dirname(comate), '../../skills-cli', path.basename(path.dirname(comate)), process.platform === 'win32' ? 'comate-skills.exe' : 'comate-skills');
    if (existsSync(candidate)) return candidate;
  }
  if (import.meta.url?.startsWith('file:')) {
    const bundle = fileURLToPath(new URL('../../../dist/skills-cli/bundle.cjs', import.meta.url));
    if (existsSync(bundle)) return bundle;
  }
  return undefined;
}
