import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoopShellLogger, createShellLogger } from './logger';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'comate-electron-logger-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createShellLogger', () => {
  it('appends leveled lines to main.log inside the logs dir', () => {
    withTempDir((dir) => {
      const logger = createShellLogger(dir, { mirrorToConsole: false });
      logger.info('hello');
      logger.error('boom');
      const content = readFileSync(join(dir, 'main.log'), 'utf8');
      assert.match(content, /\[INFO\] hello/);
      assert.match(content, /\[ERROR\] boom/);
    });
  });

  it('rotates an oversized main.log into a timestamped archive on startup', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'main.log'), 'x'.repeat(2048));
      const logger = createShellLogger(dir, { mirrorToConsole: false, maxSizeBytes: 1024 });
      logger.info('fresh boot');
      const files = readdirSync(dir).sort();
      const archives = files.filter((f) => /^main\..+\.log$/.test(f));
      assert.strictEqual(archives.length, 1, `expected one archive, saw: ${files.join(', ')}`);
      assert.match(readFileSync(join(dir, 'main.log'), 'utf8'), /fresh boot/);
    });
  });

  it('prunes archives older than the retention window and keeps recent ones', () => {
    withTempDir((dir) => {
      const oldArchive = join(dir, 'main.20000101-000000.log');
      const freshArchive = join(dir, 'main.20990101-000000.log');
      writeFileSync(oldArchive, 'old');
      writeFileSync(freshArchive, 'fresh');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      utimesSync(oldArchive, thirtyDaysAgo, thirtyDaysAgo);
      createShellLogger(dir, { mirrorToConsole: false, keepDays: 7 });
      const files = readdirSync(dir);
      assert.ok(!files.includes('main.20000101-000000.log'), 'stale archive should be pruned');
      assert.ok(files.includes('main.20990101-000000.log'), 'recent archive should be kept');
    });
  });
});

describe('createNoopShellLogger', () => {
  it('accepts log calls without creating a file sink', () => {
    const logger = createNoopShellLogger();

    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('ignored');
    logger.error('ignored');

    assert.strictEqual(logger.filePath, null);
  });
});
