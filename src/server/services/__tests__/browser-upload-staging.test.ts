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

it('rejects a same-size staged-byte replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-stage-digest-'));
  roots.push(root);
  const sourcePath = path.join(root, 'cover.png');
  await writeFile(sourcePath, 'approved');
  const source = await open(sourcePath, 'r');
  const stats = await source.stat();
  const candidate: BrowserUploadCandidate = {
    relativePath: 'cover.png', basename: 'cover.png', mimeType: 'image/png', size: stats.size,
    identity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
  };
  const service = new BrowserUploadStagingService(path.join(root, 'staging'));
  const staged = await service.stage('session', 'operation', [{ candidate, handle: source }]);
  await source.close();
  await writeFile(staged.paths[0], 'tampered');
  assert.equal(await service.verify(staged), false);
});

it('recovers after a transient initialization failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-stage-init-'));
  roots.push(root);
  const stagingRoot = path.join(root, 'staging');
  await writeFile(stagingRoot, 'temporarily unavailable');
  const service = new BrowserUploadStagingService(stagingRoot);
  await assert.rejects(service.cleanupOrphans());
  await rm(stagingRoot);
  await service.cleanupOrphans();
});

it('reserves global quota across concurrent staging operations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-stage-quota-'));
  roots.push(root);
  const sourcePath = path.join(root, 'cover.png');
  await writeFile(sourcePath, '123456');
  const first = await open(sourcePath, 'r');
  const second = await open(sourcePath, 'r');
  const stats = await first.stat();
  const candidate: BrowserUploadCandidate = {
    relativePath: 'cover.png', basename: 'cover.png', mimeType: 'image/png', size: stats.size,
    identity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
  };
  const service = new BrowserUploadStagingService(
    path.join(root, 'staging'),
    () => Date.now(),
    { sessionBytes: 10, globalBytes: 10 },
  );
  const results = await Promise.allSettled([
    service.stage('session-a', 'operation-a', [{ candidate, handle: first }]),
    service.stage('session-b', 'operation-b', [{ candidate, handle: second }]),
  ]);
  await Promise.all([first.close(), second.close()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});
