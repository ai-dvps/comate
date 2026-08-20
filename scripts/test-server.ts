import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fdir } from 'fdir';

export function discoverServerTests(rootDirectory: string): string[] {
  return new fdir()
    .withFullPaths()
    .exclude((directoryName) => directoryName === 'vendor')
    .filter((filePath) => filePath.endsWith('.test.ts'))
    .crawl(rootDirectory)
    .sync()
    .sort();
}

// Content-based classification for src/client/lib tests: the directory mixes
// node:test files (run here) with vitest files (run by the jsdom project), and
// the two sets must self-classify by their imports rather than by filename
// lists. A file belongs to the node:test bucket iff it imports 'node:test'
// and does not import 'vitest' — the vitest guard keeps any future dual-import
// file with the jsdom runner, where vitest APIs actually exist.
const NODE_TEST_IMPORT_PATTERN = /\b(?:from|import|require)\b\s*\(?\s*['"]node:test['"]/;
const VITEST_IMPORT_PATTERN = /\b(?:from|import|require)\b\s*\(?\s*['"]vitest['"]/;

export function isNodeTestFile(filePath: string): boolean {
  const source = readFileSync(filePath, 'utf8');
  return NODE_TEST_IMPORT_PATTERN.test(source) && !VITEST_IMPORT_PATTERN.test(source);
}

export function discoverLibNodeTests(rootDirectory: string): string[] {
  return new fdir()
    .withFullPaths()
    .filter((filePath) => filePath.endsWith('.test.ts') && isNodeTestFile(filePath))
    .crawl(rootDirectory)
    .sync()
    .sort();
}

function runServerTests(): void {
  const serverRoot = path.resolve('src/server');
  const libRoot = path.resolve('src/client/lib');
  const serverTests = discoverServerTests(serverRoot);
  const libTests = discoverLibNodeTests(libRoot);
  const testFiles = [...serverTests, ...libTests];
  if (testFiles.length === 0) {
    console.error(`No server tests found under ${serverRoot} or ${libRoot}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Discovered ${libTests.length} node:test files under ${libRoot}:`);
  for (const filePath of libTests) {
    console.log(`  ${path.relative(process.cwd(), filePath)}`);
  }

  // The stable `--test-isolation` flag only exists on Node 23+; Node 22 (the
  // repo-pinned toolchain, see .nvmrc/engines) carries the same feature behind
  // `--experimental-test-isolation`. tsx is loaded via `--import` rather than
  // as the entry script: under process isolation Node re-execs one child per
  // test file, and only `--import`-registered loaders propagate into those
  // children (the tsx/cli entry wrapper does not, failing with
  // ERR_METHOD_NOT_IMPLEMENTED resolveSync on Node 22).
  const isolationFlag =
    Number(process.versions.node.split('.')[0]) >= 23
      ? '--test-isolation=process'
      : '--experimental-test-isolation=process';

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      isolationFlag,
      '--test-concurrency=1',
      '--import',
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
