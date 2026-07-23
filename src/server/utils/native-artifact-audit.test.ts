import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  findNativeArtifacts,
  assertNoNativeArtifacts,
  dirSizeBytes,
  assertSizeBudget,
  detectNativeKind,
  findDanglingSymlinks,
  assertNoDanglingSymlinks,
  findNonAsciiPaths,
  assertNoNonAsciiPaths,
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

  // Symlink creation needs elevated privileges on Windows; the vendored
  // Steel build only runs where npm can create .bin links anyway.
  const symlinkIt = process.platform === 'win32' ? it.skip : it;

  symlinkIt('accepts valid relative symlinks (npm .bin shape)', () => {
    const dir = makeTree({
      'node_modules/archiver-utils/node_modules/glob/dist/esm/bin.mjs':
        '#!/usr/bin/env node\n',
    });
    try {
      const binDir = join(dir, 'node_modules/archiver-utils/node_modules/.bin');
      mkdirSync(binDir, { recursive: true });
      symlinkSync('../glob/dist/esm/bin.mjs', join(binDir, 'glob'));
      assert.deepStrictEqual(findDanglingSymlinks(dir), []);
      assert.doesNotThrow(() => assertNoDanglingSymlinks(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  symlinkIt('accepts symlinks to directories that exist', () => {
    const dir = makeTree({ 'packages/real/index.js': 'export {};\n' });
    try {
      symlinkSync(join(dir, 'packages/real'), join(dir, 'link-to-real'));
      assert.deepStrictEqual(findDanglingSymlinks(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  symlinkIt('flags relative symlinks whose target is missing', () => {
    const dir = makeTree({ 'node_modules/pkg/index.js': 'module.exports = {};' });
    try {
      const binDir = join(dir, 'node_modules/pkg/node_modules/.bin');
      mkdirSync(binDir, { recursive: true });
      symlinkSync('../missing-dep/bin.js', join(binDir, 'missing-dep'));
      assert.deepStrictEqual(findDanglingSymlinks(dir), [
        'node_modules/pkg/node_modules/.bin/missing-dep',
      ]);
      assert.throws(() => assertNoDanglingSymlinks(dir), /dangling symlinks found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  symlinkIt('flags absolute symlinks into a deleted build dir (the release-breaking shape)', () => {
    const dir = makeTree({ 'node_modules/fastify/index.js': 'module.exports = {};' });
    try {
      const binDir = join(dir, 'node_modules/fastify/node_modules/.bin');
      mkdirSync(binDir, { recursive: true });
      // Mirrors the bug: cpSync rewrote npm's relative .bin link to an
      // absolute path inside a temp build dir that no longer exists.
      symlinkSync(
        join(tmpdir(), 'comate-steel-build-gone/steel-browser/node_modules/pino/bin.js'),
        join(binDir, 'pino'),
      );
      const offenders = findDanglingSymlinks(dir);
      assert.strictEqual(offenders.length, 1);
      assert.ok(offenders[0].endsWith('.bin/pino'));
      assert.throws(() => assertNoDanglingSymlinks(dir), /resource path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes an ASCII-only tree for the non-ASCII path gate', () => {
    const dir = makeTree({
      'node_modules/fastify/index.js': 'module.exports = {};',
      'build/index.js': 'export {};\n',
    });
    try {
      assert.deepStrictEqual(findNonAsciiPaths(dir), []);
      assert.doesNotThrow(() => assertNoNonAsciiPaths(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a non-ASCII directory name via its descendant path (the @fastify/send snowman fixture)', () => {
    // WiX light.exe uses code page 1252 and aborts (LGHT0311) on the ☃ here.
    const dir = makeTree({
      'node_modules/@fastify/send/test/fixtures/snow ☃/index.html': '<html></html>',
    });
    try {
      const offenders = findNonAsciiPaths(dir);
      assert.strictEqual(offenders.length, 1);
      assert.ok(offenders[0].includes('snow ☃'));
      assert.throws(() => assertNoNonAsciiPaths(dir), /non-ASCII paths found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a non-ASCII file name directly', () => {
    const dir = makeTree({ 'node_modules/pkg/café.js': 'export {};\n' });
    try {
      const offenders = findNonAsciiPaths(dir);
      assert.strictEqual(offenders.length, 1);
      assert.ok(offenders[0].endsWith('café.js'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
