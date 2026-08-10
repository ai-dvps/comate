import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { discoverServerTests } from './test-server.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('discovers server tests in stable order and excludes vendor directories', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comate-server-tests-'));
  temporaryDirectories.push(root);

  for (const relativePath of [
    'routes/zeta.test.ts',
    'services/alpha.test.ts',
    'services/helper.ts',
    'vendor/ignored.test.ts',
    'nested/vendor/also-ignored.test.ts',
  ]) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '');
  }

  assert.deepEqual(discoverServerTests(root), [
    path.join(root, 'routes/zeta.test.ts'),
    path.join(root, 'services/alpha.test.ts'),
  ]);
});

test('returns an empty list when the server source directory has no tests', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comate-server-tests-'));
  temporaryDirectories.push(root);

  assert.deepEqual(discoverServerTests(root), []);
});
