/**
 * U1 (KTD-7): platform path pinning for the Electron shell.
 *
 * The data dir MUST resolve to the exact legacy Tauri `app_data_dir` per
 * platform so a bridged install keeps reading the same SQLite database, logs,
 * and JSON stores — any drift silently forks user data (plan AE1 failure
 * mode). The Electron shell's own `userData` (Chromium profile, caches) is
 * pinned to a `shell/` subdirectory under the same root via
 * `app.setPath('userData', ...)` in main.ts.
 *
 * This module is pure (no `electron` import) so it is unit-testable under
 * plain node:test.
 */

export const APP_ID = 'com.comate.app';

export interface PlatformEnv {
  platform: NodeJS.Platform;
  home: string;
  /** %APPDATA% (Windows Roaming). */
  appData?: string | undefined;
  /** $XDG_DATA_HOME (Linux). */
  xdgDataHome?: string | undefined;
}

/**
 * Resolve the legacy Tauri data dir:
 *  - macOS:   ~/Library/Application Support/com.comate.app
 *  - Windows: %APPDATA%\com.comate.app
 *  - Linux:   $XDG_DATA_HOME/com.comate.app (fallback ~/.local/share)
 *
 * Separators follow the TARGET platform so the result is exact even when the
 * function is exercised from tests running on another OS.
 */
export function resolveLegacyDataDir(env: PlatformEnv): string {
  switch (env.platform) {
    case 'darwin':
      return `${env.home}/Library/Application Support/${APP_ID}`;
    case 'win32': {
      const roaming =
        env.appData && env.appData.length > 0 ? env.appData : `${env.home}\\AppData\\Roaming`;
      return `${roaming}\\${APP_ID}`;
    }
    default: {
      const base =
        env.xdgDataHome && env.xdgDataHome.length > 0
          ? env.xdgDataHome
          : `${env.home}/.local/share`;
      return `${base}/${APP_ID}`;
    }
  }
}
