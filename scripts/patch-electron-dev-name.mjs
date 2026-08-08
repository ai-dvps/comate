#!/usr/bin/env node
/**
 * Dev-mode convenience (macOS only): patch the installed Electron binary's
 * Info.plist so the menu-bar app menu, dock tooltip, and Activity Monitor
 * show "Comate" instead of "Electron".
 *
 * Why: on macOS the bold application-menu title is rendered from the running
 * bundle's CFBundleName — it ignores the menu template label AND app.setName
 * (verified on Electron 43 / current macOS). In dev the bundle is
 * node_modules/electron/dist/Electron.app, so every dev launch shows
 * "Electron". Packaged builds are unaffected (electron-builder sets
 * productName: 'Comate' in the real bundle).
 *
 * The patch lives in node_modules, so it must be re-applied whenever the
 * electron package is (re)installed or upgraded — hence the postinstall
 * wiring in package.json. Idempotent; no-op off darwin or when Electron's
 * dist is not downloaded yet.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const APP_NAME = 'Comate';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const plist = join(
  process.cwd(),
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist',
);

if (!existsSync(plist)) {
  // electron's postinstall hasn't downloaded the binary (e.g. CI with
  // ELECTRON_SKIP_BINARY_DOWNLOAD) — nothing to patch.
  process.exit(0);
}

const plistBuddy = '/usr/libexec/PlistBuddy';
const get = (key) => {
  try {
    return execFileSync(plistBuddy, ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};
const set = (key, value) => {
  execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, plist]);
};

let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  const current = get(key);
  if (current === null) {
    execFileSync(plistBuddy, ['-c', `Add :${key} string ${APP_NAME}`, plist]);
    changed = true;
  } else if (current !== APP_NAME) {
    set(key, APP_NAME);
    changed = true;
  }
}

if (changed) {
  // Launch Services caches bundle metadata; touch the .app so the next dev
  // launch re-reads the plist. A running instance keeps its old menu title
  // until fully quit (close-to-tray only hides the window).
  execFileSync('touch', [join(plist, '..', '..')]);
  console.log(`[patch-electron-dev-name] Electron.app renamed to '${APP_NAME}' for dev (menu bar / dock).`);
}
