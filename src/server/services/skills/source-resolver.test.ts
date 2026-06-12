/**
 * Tests for the Skills adapter's parseSource reimplementation.
 *
 * Run via: `npx tsx --test src/server/services/skills/source-resolver.test.ts`
 *
 * Mirrors U2 test scenarios:
 *   - Happy path: `parseSource('vercel-labs/agent-skills')` returns github shape
 *   - Happy path: full GitHub URLs parse correctly
 *   - Happy path: GitLab URLs parse correctly
 *   - Happy path: local paths resolve (within workspace)
 *   - Edge case: local path outside workspace + home throws (Security #1)
 *   - Edge case: subpath with `..` segment throws
 *   - Edge case: GitHub URL with tree/ref/subpath
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSource, assertLocalPathSafe, sanitizeSubpath, isSubpathSafe } from './source-resolver.js';

describe('parseSource', () => {
  it('parses GitHub shorthand owner/repo', () => {
    const result = parseSource('vercel-labs/agent-skills');
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/vercel-labs/agent-skills.git');
    assert.strictEqual(result.subpath, undefined);
  });

  it('parses GitHub shorthand with subpath', () => {
    const result = parseSource('vercel-labs/agent-skills/skills/react-best-practices');
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/vercel-labs/agent-skills.git');
    assert.strictEqual(result.subpath, 'skills/react-best-practices');
  });

  it('parses GitHub shorthand with @skill filter', () => {
    const result = parseSource('vercel-labs/agent-skills@react-best-practices');
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/vercel-labs/agent-skills.git');
    assert.strictEqual(result.skillFilter, 'react-best-practices');
  });

  it('parses GitHub URL with tree ref and subpath', () => {
    const result = parseSource(
      'https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices'
    );
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/vercel-labs/agent-skills.git');
    assert.strictEqual(result.ref, 'main');
    assert.strictEqual(result.subpath, 'skills/react-best-practices');
  });

  it('parses plain GitHub URL', () => {
    const result = parseSource('https://github.com/anthropics/claude-code');
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/anthropics/claude-code.git');
  });

  it('parses GitLab URL with subgroups and tree ref', () => {
    const result = parseSource(
      'https://gitlab.com/group/subgroup/repo/-/tree/main/skills/foo'
    );
    assert.strictEqual(result.type, 'gitlab');
    assert.ok(result.url.endsWith('/group/subgroup/repo.git'));
    assert.strictEqual(result.ref, 'main');
    assert.strictEqual(result.subpath, 'skills/foo');
  });

  it('parses local absolute path', () => {
    const result = parseSource('/tmp/some-skill-repo');
    assert.strictEqual(result.type, 'local');
    assert.strictEqual(result.localPath, '/tmp/some-skill-repo');
  });

  it('parses local relative path', () => {
    const result = parseSource('./sibling-repo');
    assert.ok(result.type === 'local');
    assert.ok(result.localPath!.endsWith('sibling-repo'));
  });

  it('treats arbitrary https URL without .git as well-known', () => {
    const result = parseSource('https://example.com/.well-known/agent-skills/index.json');
    assert.strictEqual(result.type, 'well-known');
  });

  it('falls back to git type for ssh URLs', () => {
    const result = parseSource('git@gitea.example.com:owner/repo.git');
    assert.strictEqual(result.type, 'git');
  });

  it('respects github: prefix shorthand', () => {
    const result = parseSource('github:owner/repo');
    assert.strictEqual(result.type, 'github');
    assert.strictEqual(result.url, 'https://github.com/owner/repo.git');
  });

  it('respects gitlab: prefix shorthand', () => {
    const result = parseSource('gitlab:owner/repo');
    assert.strictEqual(result.type, 'gitlab');
    assert.strictEqual(result.url, 'https://gitlab.com/owner/repo.git');
  });

  it('applies known source aliases', () => {
    const result = parseSource('coinbase/agentWallet');
    // Should resolve to the alias target
    assert.strictEqual(result.url, 'https://github.com/coinbase/agentic-wallet-skills.git');
  });
});

describe('assertLocalPathSafe (Security #1 sandbox)', () => {
  it('accepts a path inside the workspace', () => {
    assert.doesNotThrow(() =>
      assertLocalPathSafe('/Users/foo/myproject', '/Users/foo/myproject/skills/x')
    );
  });

  it('accepts a path inside the user home directory', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      assert.doesNotThrow(() => assertLocalPathSafe(undefined, `${home}/some-repo`));
    }
  });

  it('rejects a path outside both workspace and home', () => {
    assert.throws(
      () => assertLocalPathSafe('/Users/foo/myproject', '/etc/passwd'),
      /outside the workspace and user home directory/
    );
  });

  it('rejects a path inside /proc or /sys', () => {
    assert.throws(
      () => assertLocalPathSafe('/Users/foo/myproject', '/proc/self/environ'),
      /outside the workspace and user home directory/
    );
  });

  it('rejects a workspace-relative path traversal', () => {
    // /Users/foo/myproject/../../etc is /Users/etc - outside the workspace
    assert.throws(
      () => assertLocalPathSafe('/Users/foo/myproject', '/Users/foo/myproject/../../etc'),
      /outside the workspace and user home directory/
    );
  });
});

describe('sanitizeSubpath', () => {
  it('passes through normal subpaths', () => {
    assert.strictEqual(sanitizeSubpath('skills/foo/bar'), 'skills/foo/bar');
  });

  it('rejects subpaths containing .. segments', () => {
    assert.throws(
      () => sanitizeSubpath('skills/../../etc/passwd'),
      /path traversal/
    );
  });

  it('normalizes backslashes before checking', () => {
    assert.throws(
      () => sanitizeSubpath('skills\\..\\..\\etc'),
      /path traversal/
    );
  });
});

describe('isSubpathSafe', () => {
  it('returns true for descendant paths', () => {
    assert.ok(isSubpathSafe('/repo', 'skills/foo'));
  });

  it('returns false for escaping paths', () => {
    assert.strictEqual(isSubpathSafe('/repo', '../etc'), false);
  });

  it('returns true for empty subpath', () => {
    assert.ok(isSubpathSafe('/repo', '.'));
  });
});
