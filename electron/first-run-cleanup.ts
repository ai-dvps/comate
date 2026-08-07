/**
 * U9: first-launch residue cleanup after the Tauri→Electron migration.
 *
 * The retired browser stack (legacy bundled runtime + Chrome for Testing)
 * kept per-session Chrome profiles, pidfiles, and extraction caches under the
 * shared data dir. The native stack (shell partitions under userData) never
 * touches those paths, so on launch the shell deletes them to reclaim the
 * disk (hundreds of MB for the CfT cache):
 *
 *   <dataDir>/browser/profiles   per-session Chrome profile dirs
 *   <dataDir>/browser/run        pidfiles / profile-lock residue
 *   <dataDir>/chromium           CfT extraction caches (cft-<version>-*)
 *
 * PRESERVED by construction: the site-auth SQLite (`<dataDir>/data.db` —
 * remembered-site login persistence lives there) and everything else in the
 * data dir; the cleanup only ever targets the three legacy subtrees above.
 *
 * Discipline: locked files (a still-running legacy process holding a profile)
 * are skipped and logged, never fatal — startup must not block on residue.
 * The sweep is idempotent: targets are legacy-only paths, so re-running is a
 * no-op once they are gone (a locked target is retried on the next launch).
 *
 * Pure logic (no `electron` import) so it is unit-testable under node:test.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface FirstRunCleanupLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface FirstRunCleanupDeps {
  /** Defaults to fs/promises rm({ recursive: true, force: true }). */
  rm?: (target: string) => Promise<void>;
  /** Defaults to existsSync. */
  exists?: (target: string) => boolean;
  logger: FirstRunCleanupLogger;
}

export interface FirstRunCleanupReport {
  /** Legacy subtrees found and removed (relative to the data dir). */
  removed: string[];
  /** Subtrees that could not be removed (locked/busy) — skipped, logged. */
  skipped: Array<{ target: string; error: string }>;
}

/** The legacy subtree paths (relative to the data dir) the sweep removes. */
export const FIRST_RUN_CLEANUP_TARGETS = [
  join('browser', 'profiles'),
  join('browser', 'run'),
  'chromium',
] as const;

export async function runFirstRunCleanup(
  dataDir: string,
  deps: FirstRunCleanupDeps,
): Promise<FirstRunCleanupReport> {
  const rmTarget = deps.rm ?? ((target: string) => rm(target, { recursive: true, force: true }).then(() => undefined));
  const exists = deps.exists ?? existsSync;
  const report: FirstRunCleanupReport = { removed: [], skipped: [] };

  for (const rel of FIRST_RUN_CLEANUP_TARGETS) {
    const target = join(dataDir, rel);
    if (!exists(target)) continue;
    try {
      await rmTarget(target);
      report.removed.push(rel);
    } catch (err) {
      // Locked or otherwise unremovable residue: skip + log, never block
      // startup. The next launch retries (the sweep is idempotent).
      const message = err instanceof Error ? err.message : String(err);
      report.skipped.push({ target: rel, error: message });
      deps.logger.warn(`[first-run-cleanup] skipped ${target}: ${message}`);
    }
  }

  if (report.removed.length > 0 || report.skipped.length > 0) {
    deps.logger.info(
      `[first-run-cleanup] legacy browser residue: removed=${report.removed.length} ` +
        `skipped=${report.skipped.length} (site-auth store preserved)`,
    );
  }
  return report;
}
