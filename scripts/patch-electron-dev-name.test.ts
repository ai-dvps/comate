import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureRoots: string[] = [];
const scriptPath = fileURLToPath(new URL('./patch-electron-dev-name.mjs', import.meta.url));

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'the macOS development bundle is fully rebranded before Electron launches',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'comate-electron-name-'));
    fixtureRoots.push(root);

    const electronRoot = path.join(root, 'node_modules', 'electron');
    const originalApp = path.join(electronRoot, 'dist', 'Electron.app');
    const originalExecutable = path.join(originalApp, 'Contents', 'MacOS', 'Electron');
    mkdirSync(path.dirname(originalExecutable), { recursive: true });
    writeFileSync(originalExecutable, 'fake electron executable');
    writeFileSync(
      path.join(originalApp, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Electron</string>
  <key>CFBundleExecutable</key><string>Electron</string>
  <key>CFBundleIdentifier</key><string>com.github.Electron</string>
  <key>CFBundleName</key><string>Electron</string>
</dict>
</plist>
`,
    );
    writeFileSync(path.join(electronRoot, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');

    execFileSync(process.execPath, [scriptPath], { cwd: root });
    execFileSync(process.execPath, [scriptPath], { cwd: root });

    const renamedApp = path.join(electronRoot, 'dist', 'Comate.app');
    const renamedExecutable = path.join(renamedApp, 'Contents', 'MacOS', 'Comate');
    const plist = path.join(renamedApp, 'Contents', 'Info.plist');

    assert.equal(existsSync(originalApp), false);
    assert.equal(existsSync(renamedExecutable), true);
    assert.equal(readFileSync(path.join(electronRoot, 'path.txt'), 'utf8'), 'Comate.app/Contents/MacOS/Comate');
    assert.equal(plistValue(plist, 'CFBundleName'), 'Comate');
    assert.equal(plistValue(plist, 'CFBundleDisplayName'), 'Comate');
    assert.equal(plistValue(plist, 'CFBundleExecutable'), 'Comate');
    assert.equal(plistValue(plist, 'CFBundleIdentifier'), 'com.comate.app.dev');
  },
);

function plistValue(plist: string, key: string): string {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
  }).trim();
}
