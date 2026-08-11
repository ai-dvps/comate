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
