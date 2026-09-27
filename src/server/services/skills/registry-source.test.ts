import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseRegistrySource,
  registryArchiveLimits,
  registrySourceUrl,
  validateArchiveEntries,
  validateMaterializedRegistryTree,
} from './registry-source.js';

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

    assert.strictEqual(registrySourceUrl(xfyun), 'https://skill.xfyun.cn/api/v1/download/code-review');
    assert.strictEqual(
      registrySourceUrl(skillhub),
      'https://api.skillhub.cn/api/v1/download?slug=superpowers-tdd&namespace=axelhu',
    );
    assert.strictEqual(
      registrySourceUrl(packageSource),
      'https://api.skillhub.cn/api/v1/skillsets/tech-test-automation',
    );
  });


  it('rejects malformed coordinates', () => {
    assert.strictEqual(parseRegistrySource('skillhub-package:../escape'), null);
    assert.strictEqual(parseRegistrySource('skillhub-package:..'), null);
    assert.strictEqual(parseRegistrySource('skillhub-cn:./child'), null);
    assert.strictEqual(parseRegistrySource('skillhub-cn:missing-namespace'), null);

  });

  it('rejects archive paths that escape the extraction root', () => {
    assert.throws(() => validateArchiveEntries(['safe/SKILL.md', '../escape']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['/absolute/SKILL.md']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['C:\\escape\\SKILL.md']), /unsafe path/);
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
