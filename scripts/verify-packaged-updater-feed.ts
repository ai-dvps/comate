import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { UPDATE_FEED } from '../src/shared/updater-contract';

type RunnerOs = 'Linux' | 'macOS' | 'Windows';

function packagedResourceDirs(releaseDir: string, runnerOs: RunnerOs): string[] {
  const entries = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (runnerOs === 'macOS') {
    const dirs = entries
      .filter((name) => /^mac(?:-|$)/.test(name))
      .map((name) => join(releaseDir, name, 'Comate.app', 'Contents', 'Resources'));
    if (dirs.length < 2) throw new Error(`expected x64 + arm64 macOS packages, found ${dirs.length}`);
    return dirs;
  }

  const prefix = runnerOs === 'Windows' ? 'win' : 'linux';
  const dirs = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('-unpacked'))
    .map((name) => join(releaseDir, name, 'resources'));
  if (dirs.length === 0) throw new Error(`expected at least one ${runnerOs} unpacked package`);
  return dirs;
}

export function verifyPackagedUpdaterFeeds(releaseDir: string, runnerOs: RunnerOs): string[] {
  const configPaths = packagedResourceDirs(releaseDir, runnerOs).map((resourcesDir) =>
    join(resourcesDir, 'app-update.yml'),
  );

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) throw new Error(`signed package missing ${configPath}`);
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(UPDATE_FEED)) {
      if (config[key] !== expected) {
        throw new Error(`${configPath} has ${key}=${String(config[key])}; expected ${expected}`);
      }
    }
  }

  return configPaths;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  const releaseDir = resolve(process.argv[2] ?? 'release');
  const runnerOs = process.argv[3] as RunnerOs | undefined;
  if (runnerOs !== 'Linux' && runnerOs !== 'macOS' && runnerOs !== 'Windows') {
    throw new Error('runner OS must be Linux, macOS, or Windows');
  }
  const configs = verifyPackagedUpdaterFeeds(releaseDir, runnerOs);
  console.log(`Packaged updater feeds verified: ${configs.join(', ')}`);
}
