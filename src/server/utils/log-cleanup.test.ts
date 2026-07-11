import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { getLogsDir, runLogCleanup } from './log-cleanup.js';

function seed(names: string[]): string {
  const dir = getLogsDir();
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(path.join(dir, name), 'x\n');
  }
  return dir;
}

function present(dir: string, name: string): boolean {
  return existsSync(path.join(dir, name));
}

describe('runLogCleanup', () => {
  it('deletes Node archives older than 7 days by filename date', () => {
    const dir = seed([
      'sse-diag-2026-07-01.0.log',
      'sse-diag-2026-07-02.0.log',
      'sse-diag-2026-07-03.0.log',
      'sse-diag-2026-07-05.0.log',
      'sse-diag-2026-07-10.0.log',
    ]);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'sse-diag-2026-07-01.0.log'), false);
    assert.equal(present(dir, 'sse-diag-2026-07-02.0.log'), false);
    assert.equal(present(dir, 'sse-diag-2026-07-03.0.log'), true); // cutoff day kept
    assert.equal(present(dir, 'sse-diag-2026-07-05.0.log'), true);
    assert.equal(present(dir, 'sse-diag-2026-07-10.0.log'), true);
  });

  it('handles bases that contain hyphens', () => {
    const dir = seed([
      'wecom-resolver-2026-07-01.0.log',
      'wecom-resolver-2026-07-09.0.log',
    ]);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'wecom-resolver-2026-07-01.0.log'), false);
    assert.equal(present(dir, 'wecom-resolver-2026-07-09.0.log'), true);
  });

  it('never deletes fixed-name active files', () => {
    const dir = seed([
      'sse-diag.log',
      'sidecar.log',
      'wecom-resolver.log',
      'main.log',
    ]);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'sse-diag.log'), true);
    assert.equal(present(dir, 'sidecar.log'), true);
    assert.equal(present(dir, 'wecom-resolver.log'), true);
    assert.equal(present(dir, 'main.log'), true);
  });

  it('skips Rust timestamp archives (flexi_logger owns their retention)', () => {
    const dir = seed([
      'main.log_2026-06-01T00-00-00',
      'main.log_2026-05-01T12-30-00',
    ]);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'main.log_2026-06-01T00-00-00'), true);
    assert.equal(present(dir, 'main.log_2026-05-01T12-30-00'), true);
  });

  it('ignores unrelated files', () => {
    const dir = seed(['notes.txt', '.DS_Store', 'random']);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'notes.txt'), true);
    assert.equal(present(dir, '.DS_Store'), true);
    assert.equal(present(dir, 'random'), true);
  });

  it('is a no-op when the logs directory is missing', () => {
    rmSync(getLogsDir(), { force: true, recursive: true });
    assert.doesNotThrow(() => runLogCleanup(new Date(2026, 6, 10, 12, 0, 0)));
  });

  it('reclaims across multiple streams in one pass', () => {
    const dir = seed([
      'sse-diag-2026-06-01.0.log',
      'sidecar-2026-06-15.0.log',
      'wecom-resolver-2026-07-08.0.log',
      'sse-diag.log',
    ]);
    runLogCleanup(new Date(2026, 6, 10, 12, 0, 0));
    assert.equal(present(dir, 'sse-diag-2026-06-01.0.log'), false);
    assert.equal(present(dir, 'sidecar-2026-06-15.0.log'), false);
    assert.equal(present(dir, 'wecom-resolver-2026-07-08.0.log'), true);
    assert.equal(present(dir, 'sse-diag.log'), true);
  });
});
