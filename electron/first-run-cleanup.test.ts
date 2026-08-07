import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFirstRunCleanup, FIRST_RUN_CLEANUP_TARGETS } from './first-run-cleanup';

/**
 * U9 first-launch residue cleanup: removes the legacy browser stack's
 * profiles / pidfiles / Chromium caches, preserves the site-auth SQLite,
 * tolerates locked files, and is idempotent.
 */

function makeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
    },
  };
}

/** Seed a data dir with legacy residue plus the site-auth store. */
function seedDataDir(): { dataDir: string; dbFile: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'comate-first-run-cleanup-'));
  for (const rel of FIRST_RUN_CLEANUP_TARGETS) {
    const dir = join(dataDir, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'residue.txt'), 'legacy');
  }
  // The site-auth SQLite (remembered-site login persistence) lives at the
  // data-dir root — it must survive the sweep untouched.
  const dbFile = join(dataDir, 'data.db');
  writeFileSync(dbFile, 'sqlite-bytes');
  // An unrelated data-dir subtree must survive too.
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'logs', 'main.log'), 'log');
  return { dataDir, dbFile };
}

test('removes every legacy target and preserves site-auth + unrelated data', async () => {
  const { dataDir, dbFile } = seedDataDir();
  const { logger, infos, warns } = makeLogger();

  const report = await runFirstRunCleanup(dataDir, { logger });

  assert.deepEqual(report.removed.sort(), [...FIRST_RUN_CLEANUP_TARGETS].sort());
  assert.deepEqual(report.skipped, []);
  for (const rel of FIRST_RUN_CLEANUP_TARGETS) {
    assert.equal(existsSync(join(dataDir, rel)), false, `${rel} should be gone`);
  }
  assert.equal(readFileSync(dbFile, 'utf8'), 'sqlite-bytes');
  assert.equal(readFileSync(join(dataDir, 'logs', 'main.log'), 'utf8'), 'log');
  assert.equal(infos.length, 1);
  assert.equal(warns.length, 0);
});

test('locked target is skipped + logged, other targets still removed, startup never blocked', async () => {
  const { dataDir, dbFile } = seedDataDir();
  const { logger, warns } = makeLogger();
  const locked = join('browser', 'profiles');

  const report = await runFirstRunCleanup(dataDir, {
    logger,
    rm: async (target: string) => {
      if (target.endsWith(locked)) {
        const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      // Real removal for everything else.
      const { rm } = await import('node:fs/promises');
      await rm(target, { recursive: true, force: true });
    },
  });

  assert.deepEqual(report.removed.sort(), [join('browser', 'run'), 'chromium'].sort());
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0]?.target, locked);
  assert.match(report.skipped[0]?.error ?? '', /busy or locked/);
  // The locked target still exists; the site-auth store is preserved.
  assert.equal(existsSync(join(dataDir, locked)), true);
  assert.equal(readFileSync(dbFile, 'utf8'), 'sqlite-bytes');
  assert.equal(warns.length, 1);
});

test('second run is a no-op (idempotent) and a clean data dir is untouched', async () => {
  const { dataDir } = seedDataDir();
  const { logger, infos } = makeLogger();

  await runFirstRunCleanup(dataDir, { logger });
  const second = await runFirstRunCleanup(dataDir, { logger });

  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.skipped, []);
  // No log line when there is nothing to do.
  assert.equal(infos.length, 1);

  const emptyDir = mkdtempSync(join(tmpdir(), 'comate-first-run-cleanup-empty-'));
  const empty = await runFirstRunCleanup(emptyDir, { logger });
  assert.deepEqual(empty, { removed: [], skipped: [] });
});
