/**
 * Shared home-directory resolution for the server.
 *
 * Tauri launches the sidecar from the GUI, where shell env propagation may be
 * incomplete (e.g. $HOME missing while $USERPROFILE is set on Windows), so no
 * single source is reliable. Every consumer that used to inline its own
 * cascade (claude-settings, analytics transcript paths, skills paths, skill
 * lock) resolves through this module instead.
 */

import { homedir } from 'os';

/**
 * Plausible `~` candidates in priority order, deduped with empties removed:
 * $USERPROFILE (Windows) → $HOME → $HOMEDRIVE+$HOMEPATH → os.homedir().
 *
 * Use when probing which candidate actually holds the file (existence is the
 * strongest signal — env vars can lag a home-directory move). When a single
 * home is needed without probing, use `getPrimaryHomeDir`.
 */
export function getHomeCandidates(): string[] {
  const candidates = [
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined,
    homedir(),
  ];
  return [...new Set(candidates.filter((value): value is string => !!value))];
}

/**
 * First viable home directory from the candidate cascade (equivalent to the
 * `USERPROFILE || HOME || HOMEDRIVE+HOMEPATH || homedir()` chain). Always
 * returns a value — `os.homedir()` is the final fallback.
 */
export function getPrimaryHomeDir(): string {
  return getHomeCandidates()[0] ?? homedir();
}
