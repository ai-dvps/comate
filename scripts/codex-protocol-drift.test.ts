import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';
import { normalizeCodexProtocolImports } from './lib/codex-protocol.js';

function snapshot(root: string, current = root): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of snapshot(root, absolute)) files.set(name, content);
    } else if (entry.isFile()) {
      files.set(path.relative(root, absolute), readFileSync(absolute));
    }
  }
  return files;
}

describe('Codex protocol generation', () => {
  it('matches the exact pinned binary', () => {
    const binary = resolveCodexBinary();
    assert.ok(binary, 'pinned Codex binary missing');
    const generated = mkdtempSync(path.join(tmpdir(), 'comate-codex-protocol-'));
    execFileSync(binary, ['app-server', 'generate-ts', '--out', generated]);
    normalizeCodexProtocolImports(generated);
    const checkedIn = path.resolve('src/server/generated/codex-protocol');
    const actual = snapshot(generated);
    const expected = snapshot(checkedIn);
    assert.deepEqual([...actual.keys()], [...expected.keys()]);
    for (const [name, content] of actual) assert.deepEqual(content, expected.get(name), name);
  });
});
