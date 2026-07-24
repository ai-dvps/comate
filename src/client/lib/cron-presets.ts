export type CronPresetName = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export interface DetectedPreset {
  preset: CronPresetName;
  time: string;
  dayOfWeek: number;
}

const FALLBACK: DetectedPreset = { preset: 'daily', time: '09:00', dayOfWeek: 1 };

/** Reverse-map a cron expression to a UI preset; unmatched shapes are 'custom'. */
export function detectPreset(cronExpr: string | null): DetectedPreset {
  if (!cronExpr) return FALLBACK;
  let m = cronExpr.match(/^(\d{1,2}) \* \* \* \*$/);
  if (m) return { preset: 'hourly', time: `00:${m[1].padStart(2, '0')}`, dayOfWeek: 1 };
  m = cronExpr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (m) return { preset: 'daily', time: `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`, dayOfWeek: 1 };
  m = cronExpr.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/);
  if (m) return { preset: 'weekdays', time: `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`, dayOfWeek: 1 };
  m = cronExpr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\d)$/);
  if (m) return { preset: 'weekly', time: `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`, dayOfWeek: Number(m[3]) };
  return { preset: 'custom', time: '09:00', dayOfWeek: 1 };
}

export interface PresetLabels {
  hourly: string;
  daily: string;
  weekdays: string;
  weekly: string;
  /** Localized short label for a cron day-of-week (0 = Sunday). Falls back to `D<n>`. */
  weekdayLabel?: (dayOfWeek: number) => string;
}

/** Human-readable schedule text for a cron expression; unmatched shapes pass through raw. */
export function describeCron(cronExpr: string, labels: PresetLabels): string {
  const { preset, time, dayOfWeek } = detectPreset(cronExpr);
  switch (preset) {
    case 'hourly':
      return `${labels.hourly} :${time.slice(3)}`;
    case 'daily':
      return `${labels.daily} ${time}`;
    case 'weekdays':
      return `${labels.weekdays} ${time}`;
    case 'weekly':
      return `${labels.weekly} ${labels.weekdayLabel ? labels.weekdayLabel(dayOfWeek) : `D${dayOfWeek}`} ${time}`;
    default:
      return cronExpr;
  }
}
