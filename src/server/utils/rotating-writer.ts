import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'fs';
import path from 'path';
import { getLogsDir, ensureLogsDir } from './log-cleanup.js';

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface RotatingWriterOptions {
  /** Active file name, e.g. 'sse-diag.log'. The active file keeps this fixed name. */
  name: string;
  /** Optional error handler (each logger wires its own console policy). Never throws. */
  onError?: (err: Error) => void;
  /** Clock injection for tests; defaults to the system clock. */
  now?: () => Date;
  /** Size threshold injection for tests; defaults to 100 MB. */
  maxSizeBytes?: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day (YYYY-MM-DD), matching the Rust side's local-timezone policy. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shared rolling log writer for all Node log streams.
 *
 * - Active file keeps a fixed name (`<name>`); archives are `<base>-<YYYY-MM-DD>.<N>.<ext>`.
 * - Rolls when the active file exceeds the size threshold OR when the local day changes.
 * - Daily roll has two sources (R4): a write-time date check (runtime cross-midnight) and a
 *   startup cut at construction (covers shutdown/restart or a missed run).
 * - Construction seeds state from disk so a same-day restart resumes the size threshold and
 *   the archive sequence instead of restarting at zero (R1/R7 across restarts).
 * - Uses synchronous fd IO so a roll flushes before the rename (no buffered-data loss); roll or
 *   write failure degrades to "keep appending" — never throws, never drops the line.
 */
export class RotatingWriter {
  private readonly base: string;
  private readonly ext: string;
  private readonly activePath: string;
  private readonly onError?: (err: Error) => void;
  private readonly now: () => Date;
  private readonly maxSizeBytes: number;

  private currentDate!: string;
  private currentSize!: number;
  private todaySeq!: number;
  private fd: number | null = null;

  constructor(opts: RotatingWriterOptions) {
    const parsed = path.parse(opts.name);
    this.base = parsed.name;
    this.ext = parsed.ext; // includes leading dot, e.g. '.log'
    this.activePath = path.join(getLogsDir(), opts.name);
    this.onError = opts.onError;
    this.now = opts.now ?? (() => new Date());
    this.maxSizeBytes = opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

    ensureLogsDir();
    this.seedFromDisk();
    this.openFd();
  }

  /** Append one fully-formatted line (a trailing newline is added if missing). Never throws. */
  write(line: string): void {
    try {
      ensureLogsDir();
      const today = localDate(this.now());
      const payload = line.endsWith('\n') ? line : `${line}\n`;
      const len = Buffer.byteLength(payload, 'utf8');

      if (this.currentDate !== today) {
        this.roll(today);
      } else if (this.currentSize + len > this.maxSizeBytes) {
        this.roll(today);
      }

      if (this.fd !== null) {
        writeSync(this.fd, payload);
        this.currentSize += len;
      }
    } catch (err) {
      this.onError?.(err as Error);
    }
  }

  /** Release the underlying descriptor (teardown / tests). */
  close(): void {
    this.closeFd();
  }

  private openFd(): void {
    try {
      this.fd = openSync(this.activePath, 'a');
    } catch (err) {
      this.fd = null;
      this.onError?.(err as Error);
    }
  }

  private closeFd(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }

  private archiveName(date: string, n: number): string {
    return `${this.base}-${date}.${n}${this.ext}`;
  }

  private archiveRegex(date: string): RegExp {
    return new RegExp(`^${escapeRe(this.base)}-${date}\\.(\\d+)${escapeRe(this.ext)}$`);
  }

  /** Next archive sequence number for `date` (max existing N + 1, or 0). */
  private scanMaxSeq(date: string): number {
    let entries: string[];
    try {
      entries = readdirSync(getLogsDir());
    } catch {
      return 0;
    }
    const re = this.archiveRegex(date);
    let max = -1;
    for (const name of entries) {
      const m = name.match(re);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return max + 1;
  }

  private seedFromDisk(): void {
    const today = localDate(this.now());
    let seeded = false;

    if (existsSync(this.activePath)) {
      try {
        const st = statSync(this.activePath);
        if (st.isFile()) {
          const mday = localDate(st.mtime);
          if (st.size === 0) {
            this.currentDate = today;
            this.currentSize = 0;
            this.todaySeq = this.scanMaxSeq(today);
            seeded = true;
          } else if (mday === today) {
            this.currentDate = today;
            this.currentSize = st.size;
            this.todaySeq = this.scanMaxSeq(today);
            seeded = true;
          } else {
            // Stale active from a prior local day → archive it under that day (startup cut).
            const seq = this.scanMaxSeq(mday);
            const archive = path.join(getLogsDir(), this.archiveName(mday, seq));
            try {
              renameSync(this.activePath, archive);
              this.currentDate = today;
              this.currentSize = 0;
              this.todaySeq = this.scanMaxSeq(today);
              seeded = true;
            } catch {
              // Leave the file marked stale so the next write re-attempts the cut.
              this.currentDate = mday;
              this.currentSize = st.size;
              this.todaySeq = seq;
              seeded = true;
            }
          }
        }
      } catch {
        // fall through to fresh
      }
    }

    if (!seeded) {
      this.currentDate = today;
      this.currentSize = 0;
      this.todaySeq = this.scanMaxSeq(today);
    }
  }

  private roll(today: string): void {
    const prevDate = this.currentDate;
    this.closeFd();

    if (this.currentSize > 0 && existsSync(this.activePath)) {
      const archive = path.join(getLogsDir(), this.archiveName(prevDate, this.todaySeq));
      try {
        renameSync(this.activePath, archive);
      } catch (err) {
        // Rename failed → keep appending to the active file; state unchanged.
        this.onError?.(err as Error);
        this.openFd();
        return;
      }
    }

    this.currentDate = today;
    this.currentSize = 0;
    this.todaySeq = this.scanMaxSeq(today);
    this.openFd();
  }
}
