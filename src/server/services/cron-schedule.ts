/**
 * Cron evaluation for scheduled tasks (KTD-8).
 *
 * Standard 5-field subset (minute hour day-of-month month day-of-week):
 * wildcards, single values, steps (`*\/n`, `a-b/n`), ranges, comma lists.
 * Day-of-week 0 or 7 is Sunday. When both dom and dow are constrained, a date
 * matches if either field matches (vixie-cron semantics).
 *
 * Extended syntax (`L`, `W`, `?`) and name aliases (`MON`, `JAN`) are rejected.
 *
 * All times are local. DST behavior follows the missed-run semantics of the
 * plan: a wall-clock time that never exists (spring forward) is skipped to the
 * next valid occurrence; a repeated wall-clock time (fall back) fires at the
 * first occurrence only (forward iteration never revisits it).
 */

export type CronPreset = 'hourly' | 'daily' | 'weekdays' | 'weekly';

interface CronField {
  values: ReadonlySet<number>;
  min: number;
  max: number;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  domConstrained: boolean;
  dowConstrained: boolean;
}

const FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

export class CronParseError extends Error {}

function parseField(raw: string, spec: { name: string; min: number; max: number }): CronField {
  if (/[LWO?#]/i.test(raw) || /[a-z]/i.test(raw)) {
    throw new CronParseError(
      `Unsupported token in ${spec.name} field: "${raw}" (extended syntax and name aliases are not supported)`,
    );
  }
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) throw new CronParseError(`Empty list item in ${spec.name} field`);
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(`Invalid step in ${spec.name} field: "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = stepMatch ? spec.max : lo;
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      throw new CronParseError(`Invalid token in ${spec.name} field: "${part}"`);
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new CronParseError(`Out-of-range value in ${spec.name} field: "${part}" (allowed ${spec.min}-${spec.max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(spec.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return { values, min: spec.min, max: spec.max };
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`Cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_SPECS[i]));
  const domRaw = fields[2];
  const dowRaw = fields[4];
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domConstrained: domRaw !== '*',
    dowConstrained: dowRaw !== '*',
  };
}

function matchesDay(p: ParsedCron, d: Date): boolean {
  if (!p.month.values.has(d.getMonth() + 1)) return false;
  const domMatch = p.dom.values.has(d.getDate());
  const dowMatch = p.dow.values.has(d.getDay());
  if (p.domConstrained && p.dowConstrained) return domMatch || dowMatch;
  if (p.domConstrained) return domMatch;
  if (p.dowConstrained) return dowMatch;
  return true;
}

/** True when the constructed local time round-trips (i.e. it actually exists). */
function localTimeExists(y: number, mo: number, d: number, h: number, mi: number): boolean {
  const dt = new Date(y, mo, d, h, mi, 0, 0);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === mo &&
    dt.getDate() === d &&
    dt.getHours() === h &&
    dt.getMinutes() === mi
  );
}

// Day-stepped scan; the worst valid gap is Feb 29 → next leap year (up to 8
// years, e.g. 2096 → 2104 since 2100 is not leap).
const MAX_SCAN_DAYS = 366 * 8;

/**
 * Next fire time strictly after `after`, or null when the expression yields no
 * occurrence within a year (e.g. Feb 30).
 */
export function nextCronFire(expr: string, after: Date): Date | null {
  const p = parseCron(expr);
  const start = new Date(after.getTime() + 60_000);
  start.setSeconds(0, 0);
  let candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
  const deadline = after.getTime() + MAX_SCAN_DAYS * 24 * 60 * 60_000;

  while (candidate.getTime() <= deadline) {
    if (matchesDay(p, candidate)) {
      for (const hour of sortedIn(p.hour)) {
        for (const minute of sortedIn(p.minute)) {
          const t = new Date(
            candidate.getFullYear(),
            candidate.getMonth(),
            candidate.getDate(),
            hour,
            minute,
            0,
            0,
          );
          if (t.getTime() < start.getTime()) continue;
          if (t.getTime() > deadline) return null;
          // Skip nonexistent wall-clock times (spring forward): they are
          // treated as missed — iteration simply moves on.
          if (!localTimeExists(t.getFullYear(), t.getMonth(), t.getDate(), hour, minute)) continue;
          // Repeated wall-clock times (fall back): the forward scan naturally
          // reaches the first occurrence only.
          return t;
        }
      }
    }
    candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1, 0, 0, 0, 0);
  }
  return null;
}

function sortedIn(field: CronField): number[] {
  return [...field.values].sort((a, b) => a - b);
}

/**
 * Map a UI schedule preset to a cron expression (KTD-8).
 * `time` is "HH:mm" local (default 09:00); `dayOfWeek` 0-6 (default 1).
 */
export function presetToCron(preset: CronPreset, time = '09:00', dayOfWeek = 1): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new CronParseError(`Invalid time "${time}" (expected HH:mm)`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new CronParseError(`Invalid time "${time}"`);
  switch (preset) {
    case 'hourly':
      return `${mm} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${dayOfWeek}`;
  }
}
