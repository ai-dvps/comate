import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

interface PackageJson {
  scripts?: Record<string, string>;
}

test('the Electron distribution build produces both renderer and shell bundles', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const buildCommand = packageJson.scripts?.['build:electron'] ?? '';

  assert.match(
    buildCommand,
    /(?:^|&&)\s*(?:npm run build:client|vite build)\s*(?:&&|$)/,
    'build:electron must build dist/client before electron-builder packages it',
  );
  assert.match(
    buildCommand,
    /(?:^|&&)\s*(?:npm run build:electron:shell|electron-vite build)\s*(?:&&|$)/,
    'build:electron must build the Electron main and preload bundles',
  );
});

test('the Electron development command stops all dev servers when the app quits', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const devCommand = packageJson.scripts?.['dev:electron'] ?? '';

  assert.match(
    devCommand,
    /concurrently\s+(?=[^\n]*--kill-others)(?=[^\n]*--success\s+first)/,
    'dev:electron must stop the Vite server and exit successfully when Electron quits',
  );
});

test('the Electron development command rebuilds the server sidecar and CLIs before launch', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
  const devCommand = packageJson.scripts?.['dev:electron'] ?? '';
  const sidecarCommand = packageJson.scripts?.['build:sidecar'] ?? '';
  const sidecarBuildSource = readFileSync('scripts/build-sidecar.ts', 'utf8');

  assert.match(
    devCommand,
    /^npm run patch:electron-dev-name\s*&&\s*npm run build:sidecar\s*&&\s*concurrently\b/,
    'dev:electron must rebrand the macOS dev bundle and rebuild the sidecar before starting Electron',
  );
  assert.match(
    devCommand,
    /["']npm run dev:client["']/,
    'dev:electron must keep the Vite client watcher',
  );
  assert.match(
    devCommand,
    /["']electron-vite dev["']/,
    'dev:electron must keep the Electron main and preload watchers',
  );
  assert.match(
    sidecarCommand,
    /^tsx scripts\/build-sidecar\.ts$/,
    'build:sidecar must use the sidecar build pipeline',
  );
  assert.match(
    sidecarBuildSource,
    /run\(['"]npm run build:cli['"]\)/,
    'the sidecar build must rebuild the bundled CLIs',
  );
  assert.match(
    sidecarBuildSource,
    /run\(['"]npx tsc -p tsconfig\.server\.json['"]\)/,
    'the sidecar build must recompile the server',
  );
  assert.match(
    sidecarBuildSource,
    /Bundling self-contained WeCom CLI/,
    'the sidecar build must not stage only the WeCom CLI entrypoint',
  );
  assert.match(
    sidecarBuildSource,
    /execFileSync\(wecomCommand, \['--version'\]/,
    'the sidecar build must execute the staged WeCom CLI before launch',
  );
});

test('the sidecar build re-signs both final macOS staging binaries with a stable identifier', () => {
  const sidecarBuildSource = readFileSync('scripts/build-sidecar.ts', 'utf8');

  assert.match(
    sidecarBuildSource,
    /execFileSync\(\s*['"]codesign['"],[\s\S]*?['"]--force['"][\s\S]*?['"]--sign['"][\s\S]*?['"]-['"][\s\S]*?['"]--identifier['"][\s\S]*?['"]com\.comate\.app\.sidecar['"]/,
    'macOS sidecars must receive a fresh ad-hoc signature with an identifier that replaces pkg\'s taskgated-rejected identifier',
  );
  assert.match(
    sidecarBuildSource,
    /execFileSync\(['"]codesign['"],[\s\S]*?['"]--verify['"][\s\S]*?['"]--strict['"][\s\S]*?binaryPath/,
    'the sidecar build must fail immediately when macOS rejects the refreshed signature',
  );
  assert.match(
    sidecarBuildSource,
    /copyFileSync\(sourceBinary, destBinary\);[\s\S]*?signMacBinary\(destBinary\)/,
    'the development sidecar staging path must be signed after copying',
  );
  assert.match(
    sidecarBuildSource,
    /copyFileSync\(sourceBinary, stagedBinary\);[\s\S]*?signMacBinary\(stagedBinary\)/,
    'the electron-builder sidecar staging path must be signed after copying',
  );
});
