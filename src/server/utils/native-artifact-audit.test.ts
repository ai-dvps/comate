import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  walkFiles,
  findDanglingSymlinks,
  assertNoDanglingSymlinks,
  findNonAsciiPaths,
  assertNoNonAsciiPaths,
} from './native-artifact-audit.js';

/**
 * Build-gate contract over the staged resources/ tree (KTD-13): dangling
 * symlinks and non-ASCII paths fail the build before packaging. The
 * native-artifact magic-byte detection and size-budget gates only served the
 * retired bundled browser tree and were removed in U9.
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
  it('walkFiles yields every file recursively', () => {
    const dir = makeTree({
      'a.js': 'x',
      'sub/b.js': 'y',
      'sub/deep/c.js': 'z',
    });
    try {
      const files = [...walkFiles(dir)].map((f) => f.slice(dir.length + 1));
      assert.deepStrictEqual(files.sort(), ['a.js', 'sub/b.js', 'sub/deep/c.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Symlink creation needs elevated privileges on Windows; the resource
  // staging only runs where npm can create .bin links anyway.
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
        join(tmpdir(), 'comate-vendor-build-gone/vendored-tree/node_modules/pino/bin.js'),
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
