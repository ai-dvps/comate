import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const releaseDir = resolve(process.argv[2] ?? 'release');

if (process.platform !== 'darwin') {
  console.log('macOS signature verification skipped on this platform');
  process.exit(0);
}

const apps = readdirSync(releaseDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
  .map(entry => join(releaseDir, entry.name, 'Comate.app'))
  .sort();

if (apps.length === 0) {
  throw new Error(`no packaged macOS apps found under ${releaseDir}`);
}

for (const app of apps) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    stdio: 'inherit',
  });
}

console.log(`macOS signatures verified in ${apps.length} app(s)`);
