import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fdir } from 'fdir';

const require = createRequire(import.meta.url);

export function discoverServerTests(rootDirectory: string): string[] {
  return new fdir()
    .withFullPaths()
    .exclude((directoryName) => directoryName === 'vendor')
    .filter((filePath) => filePath.endsWith('.test.ts'))
    .crawl(rootDirectory)
    .sync()
    .sort();
}

function runServerTests(): void {
  const rootDirectory = path.resolve('src/server');
  const testFiles = discoverServerTests(rootDirectory);
  if (testFiles.length === 0) {
    console.error(`No server tests found under ${rootDirectory}`);
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      '--test-isolation=process',
      '--test-concurrency=1',
      '-r',
      './src/server/test-utils/test-env.ts',
      '--test',
      '--test-force-exit',
      ...process.argv.slice(2),
      ...testFiles,
    ],
    { stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runServerTests();
}
