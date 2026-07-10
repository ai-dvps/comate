import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { RotatingWriter } from './rotating-writer.js';
import { getLogsDir } from './log-cleanup.js';

function logsDir(): string {
  return getLogsDir();
}

function dayOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readActive(name: string): string {
  return readFileSync(path.join(logsDir(), name), 'utf8');
}

function archives(base: string): string[] {
  return readdirSync(logsDir())
    .filter((n) => n.startsWith(`${base}-`))
    .sort();
}

function reset(name: string): void {
  const base = path.parse(name).name;
  let entries: string[] = [];
  try {
    entries = readdirSync(logsDir());
  } catch {
    return;
  }
  for (const f of entries) {
    if (f === name || f.startsWith(`${base}-`)) {
      try {
        rmSync(path.join(logsDir(), f), { force: true, recursive: true });
      } catch {
        // ignore
      }
    }
  }
}

describe('RotatingWriter', () => {
  it('writes to a fixed-name active file', () => {
    const name = 'u1-happy.log';
    reset(name);
    const w = new RotatingWriter({ name });
    w.write('alpha');
    w.write('beta');
    w.close();
    assert.equal(readActive(name), 'alpha\nbeta\n');
    assert.equal(archives('u1-happy').length, 0);
  });

  it('does not roll while under the size threshold on the same day', () => {
    const name = 'u1-under.log';
    reset(name);
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const w = new RotatingWriter({ name, now: () => now, maxSizeBytes: 1000 });
    w.write('x'.repeat(50));
    w.write('y'.repeat(50));
    w.close();
    assert.equal(archives('u1-under').length, 0);
    assert.equal(readActive(name).length, 102);
  });

  it('rolls to the next sequence without overwriting same-day archives (AE1)', () => {
    const name = 'u1-ae1.log';
    reset(name);
    const today = new Date(2026, 0, 1, 12, 0, 0);
    const d = dayOf(today);
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(path.join(logsDir(), `u1-ae1-${d}.0.log`), 'old\n');
    const w = new RotatingWriter({ name, now: () => today, maxSizeBytes: 10 });
    w.write('12345'); // 6 bytes → currentSize 6
    w.write('123456'); // 7 bytes → 6 + 7 > 10 → roll archives .1
    w.close();
    const ar = archives('u1-ae1');
    assert.ok(ar.includes(`u1-ae1-${d}.0.log`), 'existing .0 preserved');
    assert.ok(ar.includes(`u1-ae1-${d}.1.log`), 'rolled to .1');
    assert.equal(
      readFileSync(path.join(logsDir(), `u1-ae1-${d}.1.log`), 'utf8'),
      '12345\n',
    );
    assert.equal(readActive(name), '123456\n');
  });

  it('rolls at local midnight while running (AE2)', () => {
    const name = 'u1-ae2.log';
    reset(name);
    let clock = new Date(2026, 0, 1, 23, 59, 0);
    const w = new RotatingWriter({ name, now: () => clock, maxSizeBytes: 1_000_000 });
    w.write('day1-line');
    clock = new Date(2026, 0, 2, 0, 1, 0);
    w.write('day2-line');
    w.close();
    assert.ok(archives('u1-ae2').includes('u1-ae2-2026-01-01.0.log'));
    assert.equal(
      readFileSync(path.join(logsDir(), 'u1-ae2-2026-01-01.0.log'), 'utf8'),
      'day1-line\n',
    );
    assert.equal(readActive(name), 'day2-line\n');
  });

  it('restarts the sequence per calendar day', () => {
    const name = 'u1-seq.log';
    reset(name);
    let clock = new Date(2026, 0, 1, 12, 0, 0);
    const w = new RotatingWriter({ name, now: () => clock, maxSizeBytes: 10 });
    w.write('aaaaa'); // 6
    w.write('bbbbbb'); // 7 → roll 01-01.0
    clock = new Date(2026, 0, 2, 12, 0, 0);
    w.write('ccccc'); // cross-day → roll 01-01.1, reset to 01-02
    w.write('dddddd'); // 7 → roll 01-02.0 (seq restarted)
    w.close();
    const ar = archives('u1-seq');
    assert.ok(ar.includes('u1-seq-2026-01-01.0.log'));
    assert.ok(ar.includes('u1-seq-2026-01-01.1.log'));
    assert.ok(ar.includes('u1-seq-2026-01-02.0.log'));
  });

  it('handles an oversize single write without creating an empty archive', () => {
    const name = 'u1-big.log';
    reset(name);
    const today = new Date(2026, 0, 1, 12, 0, 0);
    const w = new RotatingWriter({ name, now: () => today, maxSizeBytes: 5 });
    w.write('1234567890'); // 11 bytes > 5, but active was empty → no empty archive
    w.close();
    assert.equal(archives('u1-big').length, 0);
    assert.equal(readActive(name), '1234567890\n');
  });

  it('keeps appending and reports error when the archive rename fails', () => {
    const name = 'u1-err.log';
    reset(name);
    const today = new Date(2026, 0, 1, 12, 0, 0);
    mkdirSync(logsDir(), { recursive: true });
    const errors: Error[] = [];
    const w = new RotatingWriter({
      name,
      now: () => today,
      maxSizeBytes: 10,
      onError: (e) => errors.push(e),
    });
    w.write('aaaaa'); // 6, active created + fd open
    chmodSync(logsDir(), 0o555); // rename needs dir write → will fail (EACCES)
    try {
      w.write('bbbbbb'); // 7 → 6 + 7 > 10 → roll rename fails → error + keep append
    } finally {
      chmodSync(logsDir(), 0o755); // restore so subsequent writes/cleanup work
    }
    assert.doesNotThrow(() => w.write('cccccc'));
    w.close();
    assert.ok(errors.length >= 1);
    // No data loss: the failed rename kept appending; a later successful roll
    // archived the accumulated lines, and the active holds the latest line.
    const d = dayOf(today);
    const archived = readFileSync(path.join(logsDir(), `u1-err-${d}.0.log`), 'utf8');
    assert.ok(archived.includes('aaaaa'));
    assert.ok(archived.includes('bbbbbb'));
    assert.equal(readActive(name), 'cccccc\n');
  });

  it('keeps independent streams independent', () => {
    reset('u1-a.log');
    reset('u1-b.log');
    const today = new Date(2026, 0, 1, 12, 0, 0);
    const a = new RotatingWriter({ name: 'u1-a.log', now: () => today, maxSizeBytes: 10 });
    const b = new RotatingWriter({ name: 'u1-b.log', now: () => today, maxSizeBytes: 10 });
    a.write('AAAAA');
    a.write('BBBBBB'); // a rolls
    b.write('x'); // b does not
    a.close();
    b.close();
    assert.ok(archives('u1-a').some((n) => n.endsWith('.0.log')));
    assert.equal(archives('u1-b').length, 0);
    assert.equal(readActive('u1-b.log'), 'x\n');
  });

  it('resumes size and sequence from disk on a same-day restart (R1/R7)', () => {
    const name = 'u1-restart.log';
    reset(name);
    const today = new Date(2026, 0, 1, 12, 0, 0);
    const d = dayOf(today);
    mkdirSync(logsDir(), { recursive: true });
    const active = path.join(logsDir(), name);
    writeFileSync(active, 'a'.repeat(60));
    writeFileSync(path.join(logsDir(), `u1-restart-${d}.0.log`), 'archived\n');
    utimesSync(active, today, today);
    const w = new RotatingWriter({ name, now: () => today, maxSizeBytes: 100 });
    w.write('b'.repeat(50)); // seeded 60 + 51 > 100 → roll to .1, .0 intact
    w.close();
    const ar = archives('u1-restart');
    assert.ok(ar.includes(`u1-restart-${d}.0.log`), 'existing .0 preserved');
    assert.ok(ar.includes(`u1-restart-${d}.1.log`), 'rolled to .1 (no overwrite)');
    assert.equal(
      readFileSync(path.join(logsDir(), `u1-restart-${d}.1.log`), 'utf8').length,
      60,
    );
    assert.equal(readActive(name), `${'b'.repeat(50)}\n`);
  });

  it('archives a stale active file at construction (startup cut, F3/AE3)', () => {
    const name = 'u1-startup.log';
    reset(name);
    const today = new Date(2026, 0, 2, 9, 0, 0);
    const yesterday = new Date(2026, 0, 1, 18, 0, 0);
    const dy = dayOf(yesterday);
    mkdirSync(logsDir(), { recursive: true });
    const active = path.join(logsDir(), name);
    writeFileSync(active, 'stale-content\n');
    utimesSync(active, yesterday, yesterday);
    const w = new RotatingWriter({ name, now: () => today, maxSizeBytes: 1000 });
    w.write('fresh');
    w.close();
    assert.ok(
      archives('u1-startup').includes(`u1-startup-${dy}.0.log`),
      'stale active archived under its day',
    );
    assert.equal(
      readFileSync(path.join(logsDir(), `u1-startup-${dy}.0.log`), 'utf8'),
      'stale-content\n',
    );
    assert.equal(readActive(name), 'fresh\n');
  });
});
