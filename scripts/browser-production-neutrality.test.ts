import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const banned = /xiaohongshu|小红书|www\.xhslink|写长文|发布长文|原创声明/i;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...sourceFiles(file));
    else if (/\.(?:ts|tsx|js|mjs|cjs|html)$/.test(name) && !/\.(?:test|spec)\./.test(name)) files.push(file);
  }
  return files;
}

describe('browser production neutrality', () => {
  it('keeps site domains, authored locators, and private endpoints out of production and deterministic fixtures', () => {
    const roots = ['src', 'electron', 'packages', 'scripts/fixtures'];
    const violations = roots.flatMap(sourceFiles).filter((file) => banned.test(readFileSync(file, 'utf8')));
    assert.deepEqual(violations, []);
  });
});
