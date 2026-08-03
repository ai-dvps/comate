import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import {
  materializeRegistrySource,
  parseRegistrySource,
  registryArchiveLimits,
  registrySourceUrl,
  validateArchiveEntries,
  validateMaterializedRegistryTree,
} from './registry-source.js';
import { WeSkillHubError, type WeSkillHubClient } from './weskillhub.js';

describe('registry source', () => {
  it('classifies package orchestration separately from standard Skills', () => {
    assert.deepStrictEqual(parseRegistrySource('skillhub-package:tech-test-automation'), {
      source: 'skillhub-package:tech-test-automation',
      kind: 'expert-package-orchestrator',
      label: 'SkillHub Expert Package',
      packageSlug: 'tech-test-automation',
    });
  });

  it('keeps SkillHub child Skills as standard registry Skills', () => {
    const source = parseRegistrySource('skillhub-cn:axelhu/superpowers-tdd');
    assert.strictEqual(source?.kind, 'skill');
    assert.strictEqual(source?.namespace, 'axelhu');
    assert.strictEqual(source?.slug, 'superpowers-tdd');
  });

  it('keeps current provider coordinates and URLs unchanged', () => {
    const xfyun = parseRegistrySource('xfyun:code-review')!;
    const skillhub = parseRegistrySource('skillhub-cn:axelhu/superpowers-tdd')!;
    const packageSource = parseRegistrySource('skillhub-package:tech-test-automation')!;
    const weskillhub = parseRegistrySource('weskillhub:116/weoa-todo')!;

    assert.strictEqual(registrySourceUrl(xfyun), 'https://skill.xfyun.cn/api/v1/download/code-review');
    assert.throws(
      () => registrySourceUrl(weskillhub),
      /resolved version transaction/,
    );
    assert.strictEqual(
      registrySourceUrl(skillhub),
      'https://api.skillhub.cn/api/v1/download?slug=superpowers-tdd&namespace=axelhu',
    );
    assert.strictEqual(
      registrySourceUrl(packageSource),
      'https://api.skillhub.cn/api/v1/skillsets/tech-test-automation',
    );
  });

  it('parses a safe WeSkillHub numeric-ID and slug coordinate', () => {
    assert.deepStrictEqual(parseRegistrySource('weskillhub:116/weoa-todo'), {
      source: 'weskillhub:116/weoa-todo',
      kind: 'skill',
      label: 'WeSkillHub',
      skillId: 116,
      slug: 'weoa-todo',
    });
  });

  it('rejects malformed coordinates', () => {
    assert.strictEqual(parseRegistrySource('skillhub-package:../escape'), null);
    assert.strictEqual(parseRegistrySource('skillhub-package:..'), null);
    assert.strictEqual(parseRegistrySource('skillhub-cn:./child'), null);
    assert.strictEqual(parseRegistrySource('skillhub-cn:missing-namespace'), null);
    for (const source of [
      'weskillhub:/weoa-todo',
      'weskillhub:not-a-number/weoa-todo',
      'weskillhub:0/weoa-todo',
      'weskillhub:116/',
      'weskillhub:116/..',
      'weskillhub:116/.hidden',
      'weskillhub:116/trailing.',
      'weskillhub:116/%2e%2e',
      'weskillhub:116/a%2fb',
      'weskillhub:116/a%5Cb',
      'weskillhub:116//absolute',
      'weskillhub:116/weoa-todo/extra',
    ]) {
      assert.strictEqual(parseRegistrySource(source), null, source);
    }
  });

  it('rejects archive paths that escape the extraction root', () => {
    assert.throws(() => validateArchiveEntries(['safe/SKILL.md', '../escape']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['/absolute/SKILL.md']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['C:\\escape\\SKILL.md']), /unsafe path/);
  });

  it('publishes a valid verified ZIP and removes archive scratch', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'registry-source-test-'));
    try {
      const zip = new AdmZip();
      zip.addFile('todo/SKILL.md', Buffer.from('---\nname: todo\n---\n# Todo\n'));
      const bytes = zip.toBuffer();
      const source = parseRegistrySource('weskillhub:116/weoa-todo')!;
      await materializeRegistrySource(source, destination, {
        weSkillHubClient: archiveClient(bytes),
      });

      assert.deepStrictEqual(await readdir(destination), ['todo']);
      assert.deepStrictEqual(await readdir(join(destination, 'todo')), ['SKILL.md']);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('cleans scratch and publishes nothing when verification or ZIP inspection fails', async () => {
    for (const client of [
      archiveClient(new Uint8Array(), new WeSkillHubError('archive')),
      archiveClient(Buffer.from('not a zip')),
    ]) {
      const destination = await mkdtemp(join(tmpdir(), 'registry-source-test-'));
      try {
        await assert.rejects(
          () => materializeRegistrySource(
            parseRegistrySource('weskillhub:116/weoa-todo')!,
            destination,
            { weSkillHubClient: client },
          ),
          (error) => error instanceof WeSkillHubError
            && error.message === 'WeSkillHub archive error'
            && !error.message.includes(destination)
            && !error.message.includes('skill.zip'),
        );
        assert.deepStrictEqual(await readdir(destination), []);
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    }
  });

  it('rejects hostile post-extraction objects and actual filesystem limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-tree-test-'));
    try {
      await writeFile(join(root, 'safe'), 'safe');
      await symlink(join(root, 'safe'), join(root, 'link'));
      await assert.rejects(() => validateMaterializedRegistryTree(root), /unsupported file type/);
      await rm(join(root, 'link'));

      await writeFile(join(root, 'oversized'), '');
      await truncate(join(root, 'oversized'), registryArchiveLimits.maxSingleFileBytes + 1);
      await assert.rejects(() => validateMaterializedRegistryTree(root), /oversized file/);
      await rm(join(root, 'oversized'));

      for (let index = 0; index < 5; index += 1) {
        const aggregatePath = join(root, `aggregate-${index}`);
        await writeFile(aggregatePath, '');
        await truncate(aggregatePath, registryArchiveLimits.maxSingleFileBytes);
      }
      await assert.rejects(() => validateMaterializedRegistryTree(root), /beyond the allowed size/);
      for (let index = 0; index < 5; index += 1) {
        await rm(join(root, `aggregate-${index}`));
      }

      for (let index = 0; index < registryArchiveLimits.maxArchiveEntries; index += 1) {
        await writeFile(join(root, `entry-${index}`), '');
      }
      await assert.rejects(() => validateMaterializedRegistryTree(root), /too many extracted entries/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function archiveClient(bytes: Uint8Array, downloadError?: Error): WeSkillHubClient {
  return {
    async searchSkills() { return []; },
    async resolveLatestVersion(input) {
      return Object.freeze({
        ...input,
        version: '1.0.0',
        fileSize: bytes.byteLength,
        sha256: '0'.repeat(64),
        downloadUrl: 'https://catalog.example/api/v1/skills/weoa-todo/download?version=1.0.0',
      });
    },
    async downloadExactVersion() {
      if (downloadError) throw downloadError;
      return bytes;
    },
  };
}
