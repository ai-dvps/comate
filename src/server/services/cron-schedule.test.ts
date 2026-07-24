import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextCronFire, parseCron, presetToCron, CronParseError } from './cron-schedule.js';

function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function isoParts(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('presetToCron', () => {
  it('maps presets to cron expressions', () => {
    assert.equal(presetToCron('hourly', '09:30'), '30 * * * *');
    assert.equal(presetToCron('daily', '09:00'), '0 9 * * *');
    assert.equal(presetToCron('weekdays', '18:05'), '5 18 * * 1-5');
    assert.equal(presetToCron('weekly', '10:15', 3), '15 10 * * 3');
  });

  it('rejects invalid time', () => {
    assert.throws(() => presetToCron('daily', '25:00'), CronParseError);
    assert.throws(() => presetToCron('daily', '9am'), CronParseError);
  });
});

describe('nextCronFire', () => {
  it('fires at the next matching minute, strictly after `after`', () => {
    const next = nextCronFire('0 9 * * *', local(2026, 7, 24, 9, 0));
    assert.equal(isoParts(next!), '2026-07-25 09:00');
  });

  it('hourly on the hour', () => {
    const next = nextCronFire('0 * * * *', local(2026, 7, 24, 9, 30));
    assert.equal(isoParts(next!), '2026-07-24 10:00');
  });

  it('steps: every 15 minutes', () => {
    const next = nextCronFire('*/15 * * * *', local(2026, 7, 24, 9, 7));
    assert.equal(isoParts(next!), '2026-07-24 09:15');
  });

  it('weekdays skip the weekend', () => {
    // 2026-07-24 is a Friday
    const next = nextCronFire('0 9 * * 1-5', local(2026, 7, 24, 10, 0));
    assert.equal(isoParts(next!), '2026-07-27 09:00'); // Monday
  });

  it('comma lists', () => {
    const next = nextCronFire('0 9,17 * * *', local(2026, 7, 24, 10, 0));
    assert.equal(isoParts(next!), '2026-07-24 17:00');
  });

  it('dom/dow OR semantics: matches either field when both constrained', () => {
    // 1st of month OR Monday; 2026-07-27 is a Monday (not the 1st)
    const next = nextCronFire('0 0 1 * 1', local(2026, 7, 24, 0, 0));
    assert.equal(isoParts(next!), '2026-07-27 00:00');
  });

  it('dom-only when dow is wildcard', () => {
    const next = nextCronFire('0 0 15 * *', local(2026, 7, 24, 0, 0));
    assert.equal(isoParts(next!), '2026-08-15 00:00');
  });

  it('Feb 29 lands on the next leap year', () => {
    const next = nextCronFire('0 0 29 2 *', local(2026, 3, 1, 0, 0));
    assert.equal(isoParts(next!), '2028-02-29 00:00');
  });

  it('returns null for impossible dates', () => {
    assert.equal(nextCronFire('0 0 30 2 *', local(2026, 1, 1, 0, 0)), null);
  });

  it('rejects invalid expressions', () => {
    assert.throws(() => parseCron('0 9 * *'), CronParseError);
    assert.throws(() => parseCron('0 9 * * * *'), CronParseError);
    assert.throws(() => parseCron('0 9 L * *'), CronParseError);
    assert.throws(() => parseCron('0 9 ? * MON'), CronParseError);
    assert.throws(() => parseCron('0 25 * * *'), CronParseError);
    assert.throws(() => parseCron('*/0 * * * *'), CronParseError);
  });
});

describe('DST behavior (America/New_York)', () => {
  it('nonexistent wall-clock time (spring forward) is skipped to the next valid occurrence', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-03-08 02:30 does not exist (clocks jump 02:00 -> 03:00)
      const next = nextCronFire('30 2 * * *', local(2026, 3, 8, 0, 0));
      assert.equal(isoParts(next!), '2026-03-09 02:30');
    } finally {
      process.env.TZ = prev;
    }
  });

  it('repeated wall-clock time (fall back) fires at the first occurrence only', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-11-01 01:30 happens twice; forward scan returns the first
      const next = nextCronFire('30 1 * * *', local(2026, 11, 1, 0, 0));
      assert.equal(isoParts(next!), '2026-11-01 01:30');
      const after = nextCronFire('30 1 * * *', next!);
      assert.equal(isoParts(after!), '2026-11-02 01:30');
    } finally {
      process.env.TZ = prev;
    }
  });
});
