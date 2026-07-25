import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneNonRuntimeDirs } from './build-steel-bundle.js';

/**
 * Vendored Steel pruning contract: we strip test/example/etc. trees to keep the
 * bundle small and avoid non-ASCII fixture names that break WiX, but the name
 * `doc` / `docs` is too generic — packages such as `yaml` ship runtime-required
 * modules under `dist/doc/`. Removing them causes MODULE_NOT_FOUND at Steel
 * startup and the browser process exits with code 1.
 */

describe('pruneNonRuntimeDirs', () => {
  it('preserves runtime-required doc directories like yaml/dist/doc', () => {
    const staging = mkdtempSync(join(tmpdir(), 'comate-steel-prune-'));
    try {
      const yamlDoc = join(staging, 'node_modules', 'yaml', 'dist', 'doc');
      const yamlCompose = join(staging, 'node_modules', 'yaml', 'dist', 'compose');
      const pkgTest = join(staging, 'node_modules', 'pkg', 'test');
      const pkgExamples = join(staging, 'node_modules', 'pkg', 'examples');

      mkdirSync(yamlDoc, { recursive: true });
      mkdirSync(yamlCompose, { recursive: true });
      mkdirSync(pkgTest, { recursive: true });
      mkdirSync(pkgExamples, { recursive: true });

      writeFileSync(join(yamlDoc, 'directives.js'), 'module.exports = {};');
      writeFileSync(join(yamlCompose, 'composer.js'), "require('../doc/directives.js');");
      writeFileSync(join(pkgTest, 'fixture.js'), '// test');
      writeFileSync(join(pkgExamples, 'demo.js'), '// example');

      pruneNonRuntimeDirs(staging);

      assert.ok(
        existsSync(join(yamlDoc, 'directives.js')),
        'yaml/dist/doc/directives.js must be preserved — it is required at runtime',
      );
      assert.ok(
        !existsSync(pkgTest),
        'test/ directories should still be pruned',
      );
      assert.ok(
        !existsSync(pkgExamples),
        'examples/ directories should still be pruned',
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
