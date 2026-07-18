import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  findNativeArtifacts,
  assertNoNativeArtifacts,
  dirSizeBytes,
  assertSizeBudget,
  detectNativeKind,
} from './native-artifact-audit.js';

/**
 * Build-gate contract (U2): the vendored Steel tree must be pure JS —
 * .node / Mach-O / PE / ELF artifacts fail the build, and the size budget
 * is enforced.
 */

function makeTree(files: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'comate-audit-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('native-artifact-audit', { concurrency: false }, () => {
  it('passes a pure-JS tree', () => {
    const dir = makeTree({
      'node_modules/fastify/index.js': 'module.exports = {};',
      'build/index.js': 'import fastify from "fastify";',
    });
    try {
      assert.deepStrictEqual(findNativeArtifacts(dir), []);
      assert.doesNotThrow(() => assertNoNativeArtifacts(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags .node files by extension', () => {
    const dir = makeTree({ 'node_modules/x/prebuilds/x.node': 'not really native' });
    try {
      const offenders = findNativeArtifacts(dir);
      assert.strictEqual(offenders.length, 1);
      assert.ok(offenders[0].startsWith('.node:'));
      assert.throws(() => assertNoNativeArtifacts(dir), /native artifacts found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects Mach-O by magic bytes even without an extension', () => {
    const dir = makeTree({ 'bin/tool': Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]) });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'bin/tool')), 'Mach-O');
      assert.strictEqual(findNativeArtifacts(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects fat/universal Mach-O (the macOS universal case)', () => {
    const dir = makeTree({ 'lib/uni': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0]) });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'lib/uni')), 'Mach-O fat/universal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects PE by MZ header', () => {
    const dir = makeTree({ 'bin/tool.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 3]) });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'bin/tool.exe')), 'PE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects ELF shared objects by magic bytes', () => {
    const dir = makeTree({ 'lib/x.so': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]) });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'lib/x.so')), 'ELF');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag ordinary JS content', () => {
    const dir = makeTree({ 'index.js': '// MZ mentioned in a comment is fine\nexport {};\n' });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'index.js')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes directory size and enforces the budget', () => {
    const dir = makeTree({
      'a.js': 'x'.repeat(100),
      'sub/b.js': 'y'.repeat(200),
    });
    try {
      assert.strictEqual(dirSizeBytes(dir), 300);
      assert.strictEqual(assertSizeBudget(dir, 300), 300);
      assert.throws(() => assertSizeBudget(dir, 299), /over the .* budget/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores sub-4-byte files when sniffing magic', () => {
    const dir = makeTree({ 'tiny': 'MZ' });
    try {
      assert.strictEqual(detectNativeKind(join(dir, 'tiny')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports every offender, not just the first', () => {
    const dir = makeTree({
      'a/x.node': 'x',
      'b/y.so': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]),
    });
    try {
      assert.strictEqual(findNativeArtifacts(dir).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
