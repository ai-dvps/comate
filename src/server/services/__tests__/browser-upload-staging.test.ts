import '../../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { BrowserUploadStagingService } from '../browser-upload-staging.js';
import type { BrowserUploadCandidate } from '../browser-upload-policy.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('copies from an approved open handle into private staging and releases by session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-stage-test-'));
  roots.push(root);
  const sourceDir = path.join(root, 'source');
  await mkdir(sourceDir);
  const sourcePath = path.join(sourceDir, 'cover.png');
  const bytes = Buffer.from('approved bytes');
  await writeFile(sourcePath, bytes);
  const source = await open(sourcePath, 'r');
  const stats = await source.stat();
  const candidate: BrowserUploadCandidate = {
    relativePath: 'source/cover.png', basename: 'cover.png', mimeType: 'image/png', size: stats.size,
    identity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
  };
  const service = new BrowserUploadStagingService(path.join(root, 'staging'));
  const staged = await service.stage('session', 'operation', [{ candidate, handle: source }]);
  await source.close();
  assert.deepEqual(await readFile(staged.paths[0]), bytes);
  assert.equal(await service.verify(staged), true);
  await service.releaseSession('session');
  assert.equal(await service.verify(staged), false);
});
