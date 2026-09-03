import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export async function runSkills(args: string[]): Promise<number> {
  const packaged = process.env.COMATE_SKILLS_CLI_PATH
    ?? path.resolve(path.dirname(process.execPath), '../../skills-cli', path.basename(path.dirname(process.execPath)), process.platform === 'win32' ? 'comate-skills.exe' : 'comate-skills');
  let executable = packaged;
  let argv = args;
  if (!existsSync(executable)) {
    const bundle = import.meta.url ? fileURLToPath(new URL('../../../../dist/skills-cli/bundle.cjs', import.meta.url)) : '';
    if (!bundle || !existsSync(bundle)) throw new Error('Bundled Skills CLI is missing. Rebuild Comate CLI resources.');
    executable = process.execPath;
    argv = [bundle, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: 'inherit', env: process.env, cwd: process.cwd(), windowsHide: true });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}
