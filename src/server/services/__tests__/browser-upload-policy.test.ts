import '../../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BrowserUploadPolicyError,
  inspectBrowserUploadCandidates,
  reopenApprovedBrowserUpload,
} from '../browser-upload-policy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-upload-policy-'));
  roots.push(root);
  await mkdir(path.join(root, 'media'));
  return root;
}

describe('browser upload policy', () => {
  it('accepts a single-link workspace PNG and reopens the approved identity', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'media', 'cover.png'), PNG);
    const [candidate] = await inspectBrowserUploadCandidates(root, ['media/cover.png'], 'image/*');
    assert.equal(candidate.mimeType, 'image/png');
    const handle = await reopenApprovedBrowserUpload(root, candidate);
    assert.equal((await handle.stat()).size, PNG.length);
    await handle.close();
  });

  for (const invalid of ['/tmp/a.png', '../a.png', '.env', 'media/.secret.png']) {
    it(`rejects unsafe relative path ${invalid}`, async () => {
      const root = await workspace();
      await assert.rejects(inspectBrowserUploadCandidates(root, [invalid]), BrowserUploadPolicyError);
    });
  }

  it('rejects parent symlinks, final symlinks, and hard links', async () => {
    const root = await workspace();
    const outside = await mkdtemp(path.join(tmpdir(), 'browser-upload-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'outside.png'), PNG);
    await symlink(outside, path.join(root, 'linked'));
    await symlink(path.join(outside, 'outside.png'), path.join(root, 'media', 'link.png'));
    await link(path.join(outside, 'outside.png'), path.join(root, 'media', 'hard.png'));
    for (const candidate of ['linked/outside.png', 'media/link.png', 'media/hard.png']) {
      await assert.rejects(inspectBrowserUploadCandidates(root, [candidate]), BrowserUploadPolicyError);
    }
  });

  it('rejects extension/signature mismatch and page accept narrowing', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'media', 'fake.png'), Buffer.from('not png'));
    await writeFile(path.join(root, 'media', 'real.png'), PNG);
    await assert.rejects(inspectBrowserUploadCandidates(root, ['media/fake.png']), /signature/i);
    await assert.rejects(inspectBrowserUploadCandidates(root, ['media/real.png'], 'video/*'), /does not accept/i);
  });

  it('detects replacement after approval', async () => {
    const root = await workspace();
    const source = path.join(root, 'media', 'cover.png');
    await writeFile(source, PNG);
    const [candidate] = await inspectBrowserUploadCandidates(root, ['media/cover.png']);
    await writeFile(path.join(root, 'media', 'replacement.png'), Buffer.concat([PNG, Buffer.from([4])]));
    await rename(path.join(root, 'media', 'replacement.png'), source);
    await assert.rejects(reopenApprovedBrowserUpload(root, candidate), /changed after approval/i);
  });
});
