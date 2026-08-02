import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('recovers required scalars from registry documents with an unquoted colon', () => {
    const parsed = parseFrontmatter(`---\nname: superpowers-tdd\ndescription: Use this flow: red, green, refactor\n---\n# TDD\n`);
    assert.strictEqual(parsed.data.name, 'superpowers-tdd');
    assert.strictEqual(parsed.data.description, 'Use this flow: red, green, refactor');
    assert.strictEqual(parsed.content, '# TDD\n');
  });
});
