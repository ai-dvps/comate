import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { discoverLibNodeTests, discoverServerTests, isNodeTestFile } from './test-server.ts';

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

test('discovers only lib tests that import node:test and not vitest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comate-lib-tests-'));
  temporaryDirectories.push(root);

  const files: Record<string, string> = {
    'node-test.test.ts': "import { test } from 'node:test';\n",
    'multiline-import.test.ts': "import {\n  test,\n} from \"node:test\";\n",
    'require-style.test.ts': "const { test } = require('node:test');\n",
    'vitest.test.ts': "import { test } from 'vitest';\n",
    'dual-import.test.ts': "import { test } from 'node:test';\nimport { vi } from 'vitest';\n",
    'no-framework.test.ts': "import assert from 'node:assert/strict';\n",
    'helper.ts': "import { test } from 'node:test';\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFileSync(path.join(root, relativePath), contents);
  }

  assert.deepEqual(discoverLibNodeTests(root), [
    path.join(root, 'multiline-import.test.ts'),
    path.join(root, 'node-test.test.ts'),
    path.join(root, 'require-style.test.ts'),
  ]);
});

test('isNodeTestFile rejects files importing vitest even when node:test is present', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comate-lib-tests-'));
  temporaryDirectories.push(root);

  const dualImport = path.join(root, 'dual.test.ts');
  writeFileSync(dualImport, "import { test } from 'node:test';\nimport { vi } from 'vitest';\n");
  const vitestOnly = path.join(root, 'vitest.test.ts');
  writeFileSync(vitestOnly, "import { describe } from 'vitest';\n");
  const nodeTestOnly = path.join(root, 'node.test.ts');
  writeFileSync(nodeTestOnly, "import { describe } from 'node:test';\n");

  assert.equal(isNodeTestFile(dualImport), false);
  assert.equal(isNodeTestFile(vitestOnly), false);
  assert.equal(isNodeTestFile(nodeTestOnly), true);
});
