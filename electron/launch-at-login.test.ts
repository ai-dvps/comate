import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  getLinuxLaunchAtLogin,
  linuxAutostartFilePath,
  setLinuxLaunchAtLogin,
} from './launch-at-login';

const tempDirs: string[] = [];

function makeConfigHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'comate-launch-at-login-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Linux launch-at-login', () => {
  it('creates a valid XDG autostart entry and reports it enabled', () => {
    const configHome = makeConfigHome();

    setLinuxLaunchAtLogin(configHome, '/opt/Comate App/comate', true);

    const filePath = linuxAutostartFilePath(configHome);
    assert.equal(existsSync(filePath), true);
    assert.equal(getLinuxLaunchAtLogin(configHome), true);
    assert.match(readFileSync(filePath, 'utf8'), /^\[Desktop Entry\]\nType=Application\n/);
    assert.match(readFileSync(filePath, 'utf8'), /Exec="\/opt\/Comate App\/comate"/);
  });

  it('escapes characters with special meaning inside a desktop Exec value', () => {
    const configHome = makeConfigHome();

    setLinuxLaunchAtLogin(configHome, '/opt/$Comate`/comate\\"bin', true);

    const contents = readFileSync(linuxAutostartFilePath(configHome), 'utf8');
    assert.match(contents, /Exec="\/opt\/\\\$Comate\\`\/comate\\\\\\"bin"/);
  });

  it('removes the autostart entry when disabled and tolerates repeated disables', () => {
    const configHome = makeConfigHome();
    setLinuxLaunchAtLogin(configHome, '/opt/comate', true);

    setLinuxLaunchAtLogin(configHome, '/opt/comate', false);
    setLinuxLaunchAtLogin(configHome, '/opt/comate', false);

    assert.equal(getLinuxLaunchAtLogin(configHome), false);
  });
});
