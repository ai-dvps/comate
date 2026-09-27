import { describe, it } from 'node:test';
import assert from 'node:assert';
import { APP_ID, resolveLegacyDataDir } from './paths';

/**
 * U1 (KTD-7): the Electron shell must pin the data dir to the exact legacy
 * Tauri paths so bridged installs keep reading the same SQLite/logs. Any drift
 * silently forks user data (plan AE1 failure mode).
 */
describe('resolveLegacyDataDir', () => {
  it('pins the macOS data dir to the legacy Tauri app_data_dir', () => {
    assert.strictEqual(APP_ID, 'com.comate.app');
    assert.strictEqual(
      resolveLegacyDataDir({ platform: 'darwin', home: '/Users/alice' }),
      '/Users/alice/Library/Application Support/com.comate.app',
    );
  });

  it('pins the Windows data dir to %APPDATA%\\com.comate.app', () => {
    assert.strictEqual(
      resolveLegacyDataDir({
        platform: 'win32',
        home: 'C:\\Users\\alice',
        appData: 'C:\\Users\\alice\\AppData\\Roaming',
      }),
      'C:\\Users\\alice\\AppData\\Roaming\\com.comate.app',
    );
  });

  it('falls back to <home>\\AppData\\Roaming when APPDATA is missing', () => {
    assert.strictEqual(
      resolveLegacyDataDir({ platform: 'win32', home: 'C:\\Users\\alice' }),
      'C:\\Users\\alice\\AppData\\Roaming\\com.comate.app',
    );
  });

  it('pins the Linux data dir to $XDG_DATA_HOME/com.comate.app when set', () => {
    assert.strictEqual(
      resolveLegacyDataDir({ platform: 'linux', home: '/home/alice', xdgDataHome: '/data' }),
      '/data/com.comate.app',
    );
  });

  it('falls back to ~/.local/share/com.comate.app when XDG_DATA_HOME is missing or empty', () => {
    assert.strictEqual(
      resolveLegacyDataDir({ platform: 'linux', home: '/home/alice' }),
      '/home/alice/.local/share/com.comate.app',
    );
    assert.strictEqual(
      resolveLegacyDataDir({ platform: 'linux', home: '/home/alice', xdgDataHome: '' }),
      '/home/alice/.local/share/com.comate.app',
    );
  });
});
