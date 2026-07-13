import '../test-utils/test-env.js';
/**
 * Run via: `npx tsx --test src/server/utils/home-dir.test.ts`
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { getHomeCandidates, getPrimaryHomeDir } from './home-dir.js';

describe('home-dir', () => {
  const ENV_KEYS = ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH'] as const;
  const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  // Restore semantics: assigning `undefined` to process.env coerces to the
  // literal string "undefined" — delete the key instead when it was unset.
  function restoreEnv() {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('getHomeCandidates', () => {
    it('falls back to os.homedir() when no env vars are set', () => {
      assert.deepEqual(getHomeCandidates(), [homedir()]);
    });

    it('orders candidates USERPROFILE → HOME → HOMEDRIVE+HOMEPATH → homedir()', () => {
      process.env.USERPROFILE = 'C:\\Users\\alice';
      process.env.HOME = '/home/alice';
      process.env.HOMEDRIVE = 'D:';
      process.env.HOMEPATH = '\\alt';

      // os.homedir() itself consults $HOME (POSIX) / $USERPROFILE (Windows),
      // so it duplicates an earlier candidate here and is deduped away.
      assert.deepEqual(getHomeCandidates(), [
        'C:\\Users\\alice',
        '/home/alice',
        'D:\\alt',
      ]);
    });

    it('skips HOMEDRIVE+HOMEPATH unless both are set', () => {
      process.env.HOMEDRIVE = 'D:';

      assert.deepEqual(getHomeCandidates(), [homedir()]);
    });

    it('dedupes identical candidates and drops empty strings', () => {
      const home = '/home/alice';
      process.env.USERPROFILE = home;
      process.env.HOME = home;
      process.env.HOMEDRIVE = '';
      process.env.HOMEPATH = '';

      // homedir() also resolves to `home` here (see the ordering test), so
      // the whole cascade collapses to a single entry.
      assert.deepEqual(getHomeCandidates(), [home]);
    });
  });

  describe('getPrimaryHomeDir', () => {
    it('returns the first candidate in priority order', () => {
      process.env.HOME = '/home/alice';
      process.env.USERPROFILE = 'C:\\Users\\alice';

      assert.equal(getPrimaryHomeDir(), 'C:\\Users\\alice');
    });

    it('treats an empty USERPROFILE as unset', () => {
      process.env.USERPROFILE = '';
      process.env.HOME = '/home/alice';

      assert.equal(getPrimaryHomeDir(), '/home/alice');
    });

    it('falls back to os.homedir() when nothing is set', () => {
      assert.equal(getPrimaryHomeDir(), homedir());
    });
  });
});
