#!/usr/bin/env node
/**
 * Dev-mode convenience (macOS only): rebrand the installed Electron bundle
 * so the menu-bar app menu, Dock tooltip, and Activity Monitor show "Comate"
 * instead of "Electron".
 *
 * Why: app.setName only changes Electron's internal name; macOS identifies
 * the running application from its bundle and executable. Changing only
 * CFBundleName/CFBundleDisplayName leaves the dev process as Electron. The
 * complete rename below mirrors Electron's documented macOS rebranding
 * contract. Packaged builds are unaffected (electron-builder already emits a
 * fully branded Comate bundle).
 *
 * The patch lives in node_modules, so it must be re-applied whenever the
 * electron package is (re)installed or upgraded — hence the postinstall
 * wiring in package.json. Idempotent; no-op off darwin or when Electron's
 * dist is not downloaded yet.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const APP_NAME = 'Comate';
const DEV_BUNDLE_ID = 'com.comate.app.dev';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const electronRoot = join(process.cwd(), 'node_modules', 'electron');
const distDir = join(electronRoot, 'dist');
const originalApp = join(distDir, 'Electron.app');
const brandedApp = join(distDir, `${APP_NAME}.app`);
const appBundle = existsSync(originalApp) ? originalApp : brandedApp;
const plist = join(appBundle, 'Contents', 'Info.plist');

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
for (const [key, value] of [
  ['CFBundleName', APP_NAME],
  ['CFBundleDisplayName', APP_NAME],
  ['CFBundleExecutable', APP_NAME],
  ['CFBundleIdentifier', DEV_BUNDLE_ID],
]) {
  const current = get(key);
  if (current === null) {
    execFileSync(plistBuddy, ['-c', `Add :${key} string ${value}`, plist]);
    changed = true;
  } else if (current !== value) {
    set(key, value);
    changed = true;
  }
}

const executableDir = join(appBundle, 'Contents', 'MacOS');
const originalExecutable = join(executableDir, 'Electron');
const brandedExecutable = join(executableDir, APP_NAME);
if (existsSync(originalExecutable)) {
  if (existsSync(brandedExecutable)) {
    rmSync(brandedExecutable);
  }
  renameSync(originalExecutable, brandedExecutable);
  changed = true;
}

if (appBundle === originalApp) {
  rmSync(brandedApp, { recursive: true, force: true });
  renameSync(originalApp, brandedApp);
  changed = true;
}

const electronPath = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const pathFile = join(electronRoot, 'path.txt');
const currentPath = existsSync(pathFile) ? readFileSync(pathFile, 'utf8') : '';
if (currentPath !== electronPath) {
  writeFileSync(pathFile, electronPath);
  changed = true;
}

if (changed) {
  // Launch Services caches bundle metadata; touch the renamed app so the next
  // dev launch creates a fresh Dock tile. A running instance keeps its old
  // identity until fully quit (close-to-tray only hides the window).
  execFileSync('touch', [brandedApp]);
  console.log(`[patch-electron-dev-name] Electron.app fully rebranded as '${APP_NAME}.app' for development.`);
}
