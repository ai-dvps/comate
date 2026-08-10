import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, test } from 'node:test';
import { createPackageWithOptions } from '@electron/asar';
import {
  normalizeArchiveEntryPath,
  verifyPackagedRenderers,
} from './verify-packaged-renderer.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type RendererFixture = 'complete' | 'missing-renderer' | 'missing-entry-asset' | 'no-js-entry';

async function makeArchive(fixture: RendererFixture): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comate-renderer-archive-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'source');
  const resources = path.join(root, 'unpacked', 'resources');
  mkdirSync(path.join(source, 'dist', 'client', 'assets'), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(path.join(source, 'package.json'), '{}');

  if (fixture !== 'missing-renderer') {
    const script =
      fixture === 'no-js-entry' ? '' : '<script type="module" src="/assets/index-abc.js"></script>';
    writeFileSync(
      path.join(source, 'dist', 'client', 'index.html'),
      script + '<link rel="stylesheet" href="/assets/index-def.css">',
    );
    if (fixture !== 'missing-entry-asset' && fixture !== 'no-js-entry') {
      writeFileSync(path.join(source, 'dist', 'client', 'assets', 'index-abc.js'), '');
    }
    writeFileSync(path.join(source, 'dist', 'client', 'assets', 'index-def.css'), '');
  }

  const archive = path.join(resources, 'app.asar');
  const output = await createPackageWithOptions(source, archive, {});
  await finished(output);
  return path.join(root, 'unpacked');
}

test('accepts a packaged renderer whose referenced entry assets exist', async () => {
  const packageRoot = await makeArchive('complete');
  assert.equal(verifyPackagedRenderers(packageRoot).length, 1);
});

test('rejects the renderer-less archive produced by the broken CI build', async () => {
  const packageRoot = await makeArchive('missing-renderer');
  assert.throws(
    () => verifyPackagedRenderers(packageRoot),
    /missing \/dist\/client\/index\.html/,
  );
});

test('normalizes Windows ASAR entry separators before membership checks', () => {
  assert.equal(
    normalizeArchiveEntryPath('\\dist\\client\\index.html'),
    '/dist/client/index.html',
  );
});

test('rejects a renderer whose referenced entry asset is absent', async () => {
  const packageRoot = await makeArchive('missing-entry-asset');
  assert.throws(() => verifyPackagedRenderers(packageRoot), /is missing renderer assets/);
});

test('rejects a renderer index without a JavaScript entry asset', async () => {
  const packageRoot = await makeArchive('no-js-entry');
  assert.throws(() => verifyPackagedRenderers(packageRoot), /has no JavaScript entry asset/);
});
