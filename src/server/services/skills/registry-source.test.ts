import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRegistrySource, validateArchiveEntries } from './registry-source.js';

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

  it('rejects malformed coordinates', () => {
    assert.strictEqual(parseRegistrySource('skillhub-package:../escape'), null);
    assert.strictEqual(parseRegistrySource('skillhub-cn:missing-namespace'), null);
  });

  it('rejects archive paths that escape the extraction root', () => {
    assert.throws(() => validateArchiveEntries(['safe/SKILL.md', '../escape']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['/absolute/SKILL.md']), /unsafe path/);
    assert.throws(() => validateArchiveEntries(['C:\\escape\\SKILL.md']), /unsafe path/);
  });
});
