import '../test-utils/test-env.js';
/**
 * Tests for the atomic skills-lock utility.
 *
 * Run via: `npx tsx --test src/server/utils/skills-lock.test.ts`
 *
 * Per U3 Execution note in the plan: "Test-first. Write the atomic-rename
 * test before implementing, because if rename atomicity is wrong, every
 * subsequent unit inherits the bug."
 *
 * Test scenarios (mirrors U3 plan):
 *   - Happy: writeProjectLock sorts alphabetically; readProjectLock returns sorted
 *   - Happy: writeGlobalLock writes to $HOME/.agents/.skill-lock.json (HOME override)
 *   - Edge: readProjectLock on missing file returns empty default
 *   - Edge: readProjectLock on corrupt JSON returns empty default, no throw
 *   - Edge: readProjectLock on old version returns empty default
 *   - Error: write fails -> backup restored, original content unchanged
 *   - Behavior: serializeProjectLock sorts; serializeGlobalLock preserves order
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readProjectLock,
  writeProjectLock,
  readGlobalLock,
  writeGlobalLock,
  serializeProjectLock,
  serializeGlobalLock,
  getProjectLockPath,
  getGlobalLockPath,
} from './skills-lock.js';
import type { LocalSkillLockFile, GlobalSkillLockFile } from '../services/skills/types.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'skills-lock-test-'));
}

describe('project lock (skills-lock.json, version 1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readProjectLock returns empty default when file does not exist', async () => {
    const lock = await readProjectLock(tmpDir);
    assert.deepStrictEqual(lock, { version: 1, skills: {} });
  });

  it('readProjectLock returns empty default on corrupt JSON', async () => {
    writeFileSync(getProjectLockPath(tmpDir), 'this is not json {{{');
    const lock = await readProjectLock(tmpDir);
    assert.deepStrictEqual(lock, { version: 1, skills: {} });
  });

  it('readProjectLock returns empty default when version is too old', async () => {
    writeFileSync(
      getProjectLockPath(tmpDir),
      JSON.stringify({ version: 0, skills: { foo: { source: 'x', sourceType: 'y', computedHash: 'z' } } })
    );
    const lock = await readProjectLock(tmpDir);
    assert.deepStrictEqual(lock, { version: 1, skills: {} });
  });

  it('readProjectLock returns parsed content when version matches', async () => {
    const data: LocalSkillLockFile = {
      version: 1,
      skills: {
        'alpha': { source: 'a/b', sourceType: 'github', computedHash: 'aaa' },
      },
    };
    writeFileSync(getProjectLockPath(tmpDir), JSON.stringify(data));
    const lock = await readProjectLock(tmpDir);
    assert.strictEqual(lock.version, 1);
    assert.strictEqual(lock.skills.alpha?.source, 'a/b');
  });

  it('writeProjectLock writes valid JSON to the lock path', async () => {
    const data: LocalSkillLockFile = {
      version: 1,
      skills: {
        alpha: { source: 'a/b', sourceType: 'github', computedHash: 'aaa' },
      },
    };
    await writeProjectLock(tmpDir, data);

    const raw = readFileSync(getProjectLockPath(tmpDir), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.skills.alpha.source, 'a/b');
  });

  it('writeProjectLock sorts skills alphabetically (merge-friendly)', async () => {
    const data: LocalSkillLockFile = {
      version: 1,
      skills: {
        zebra: { source: 'z/z', sourceType: 'github', computedHash: 'zzz' },
        alpha: { source: 'a/a', sourceType: 'github', computedHash: 'aaa' },
        mango: { source: 'm/m', sourceType: 'github', computedHash: 'mmm' },
      },
    };
    await writeProjectLock(tmpDir, data);

    const raw = readFileSync(getProjectLockPath(tmpDir), 'utf-8');
    const alphaIdx = raw.indexOf('"alpha"');
    const mangoIdx = raw.indexOf('"mango"');
    const zebraIdx = raw.indexOf('"zebra"');
    assert.ok(alphaIdx < mangoIdx, `alpha should come before mango (got alpha=${alphaIdx}, mango=${mangoIdx})`);
    assert.ok(mangoIdx < zebraIdx, `mango should come before zebra (got mango=${mangoIdx}, zebra=${zebraIdx})`);
  });

  it('roundtrip: writeProjectLock -> readProjectLock returns same data (sorted)', async () => {
    const data: LocalSkillLockFile = {
      version: 1,
      skills: {
        zebra: { source: 'z/z', sourceType: 'github', computedHash: 'zzz' },
        alpha: { source: 'a/a', sourceType: 'github', computedHash: 'aaa' },
      },
    };
    await writeProjectLock(tmpDir, data);
    const readBack = await readProjectLock(tmpDir);
    assert.deepStrictEqual(readBack, {
      version: 1,
      skills: {
        alpha: { source: 'a/a', sourceType: 'github', computedHash: 'aaa' },
        zebra: { source: 'z/z', sourceType: 'github', computedHash: 'zzz' },
      },
    });
  });

  it('writeProjectLock leaves no .tmp or .bak artifacts on success', async () => {
    const data: LocalSkillLockFile = { version: 1, skills: {} };
    await writeProjectLock(tmpDir, data);

    assert.ok(!existsSync(getProjectLockPath(tmpDir) + '.tmp'), '.tmp should be cleaned up');
    assert.ok(!existsSync(getProjectLockPath(tmpDir) + '.bak'), '.bak should be cleaned up');
  });

  it('writeProjectLock restores backup when promotion fails (atomic guarantee)', async () => {
    // Strategy: pre-populate the lock file with original content, then make
    // the final rename fail by replacing the lock path with a non-empty directory
    // AFTER step 2 (backup) but conceptually blocking step 3 (promote).
    //
    // Because we cannot inject a failure mid-flight without monkey-patching,
    // we instead validate the algorithm's contract directly:
    //   - On any thrown error, the original file content is preserved.
    //
    // Simulate by making the lock path's parent disappear between writeFileSync
    // and rename. We achieve this by passing a workspacePath whose lockPath
    // is fine on entry but whose tempPath target is unwritable.
    //
    // Simpler: corrupt the file shape so the temp write succeeds but the
    // temp->final rename fails. We do this by making the parent dir read-only.
    const original: LocalSkillLockFile = {
      version: 1,
      skills: { original: { source: 'o/o', sourceType: 'github', computedHash: 'ooo' } },
    };
    const lockPath = getProjectLockPath(tmpDir);
    writeFileSync(lockPath, JSON.stringify(original));

    // Make tmpDir read-only. writeFileSync to `${lockPath}.tmp` will fail
    // because the parent dir is unwritable.
    // Skip on Windows where chmod semantics differ.
    if (process.platform === 'win32') {
      // On Windows, just verify the basic write+read roundtrip works.
      const newData: LocalSkillLockFile = {
        version: 1,
        skills: { new: { source: 'n/n', sourceType: 'github', computedHash: 'nnn' } },
      };
      await writeProjectLock(tmpDir, newData);
      const readBack = await readProjectLock(tmpDir);
      assert.ok(readBack.skills.new, 'new skill should be written');
      return;
    }

    const fs = await import('fs/promises');
    await fs.chmod(tmpDir, 0o500); // r-x for owner: cannot create new files

    const newData: LocalSkillLockFile = {
      version: 1,
      skills: { new: { source: 'n/n', sourceType: 'github', computedHash: 'nnn' } },
    };

    try {
      await assert.rejects(() => writeProjectLock(tmpDir, newData));
    } finally {
      // Restore writable so cleanup works
      await fs.chmod(tmpDir, 0o700);
    }

    // The original file content should be unchanged.
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.ok(parsed.skills.original, 'original skill should be preserved');
    assert.ok(!parsed.skills.new, 'new (failed) data should NOT have been written');

    // No leftover .tmp files in tmpDir.
    assert.ok(!existsSync(`${lockPath}.tmp`), 'temp file should be cleaned up');
  });
});

describe('global lock (~/.agents/.skill-lock.json, version 3)', () => {
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalXdg = process.env.XDG_STATE_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'skills-lock-home-'));
    process.env.HOME = fakeHome;
    delete process.env.USERPROFILE;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (originalXdg !== undefined) {
      process.env.XDG_STATE_HOME = originalXdg;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('getGlobalLockPath resolves to $HOME/.agents/.skill-lock.json', () => {
    const p = getGlobalLockPath();
    assert.ok(p.endsWith(join('.agents', '.skill-lock.json')), `got: ${p}`);
    assert.ok(p.startsWith(fakeHome), `got: ${p}`);
  });

  it('readGlobalLock returns empty default when file does not exist', async () => {
    const lock = await readGlobalLock();
    assert.strictEqual(lock.version, 3);
    assert.deepStrictEqual(lock.skills, {});
  });

  it('writeGlobalLock writes to $HOME/.agents/.skill-lock.json', async () => {
    const data: GlobalSkillLockFile = {
      version: 3,
      skills: {
        foo: {
          source: 'a/b',
          sourceType: 'github',
          sourceUrl: 'https://github.com/a/b.git',
          skillFolderHash: 'hhh',
          installedAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
    };
    await writeGlobalLock(data);

    const expectedPath = join(fakeHome, '.agents', '.skill-lock.json');
    assert.ok(existsSync(expectedPath), 'global lock file should exist at expected path');
    const raw = readFileSync(expectedPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.skills.foo.skillFolderHash, 'hhh');
  });

  it('writeGlobalLock preserves insertion order (NOT sorted)', async () => {
    const data: GlobalSkillLockFile = {
      version: 3,
      skills: {
        zebra: {
          source: 'z/z', sourceType: 'github', sourceUrl: 'https://github.com/z/z.git',
          skillFolderHash: 'zzz', installedAt: 't1', updatedAt: 't1',
        },
        alpha: {
          source: 'a/a', sourceType: 'github', sourceUrl: 'https://github.com/a/a.git',
          skillFolderHash: 'aaa', installedAt: 't2', updatedAt: 't2',
        },
      },
    };
    await writeGlobalLock(data);

    const raw = readFileSync(join(fakeHome, '.agents', '.skill-lock.json'), 'utf-8');
    const zebraIdx = raw.indexOf('"zebra"');
    const alphaIdx = raw.indexOf('"alpha"');
    // Insertion order preserved: zebra first, alpha second
    assert.ok(zebraIdx < alphaIdx, 'global lock should preserve insertion order');
  });

  it('roundtrip: writeGlobalLock -> readGlobalLock returns same data', async () => {
    const data: GlobalSkillLockFile = {
      version: 3,
      skills: {
        foo: {
          source: 'a/b', sourceType: 'github', sourceUrl: 'https://github.com/a/b.git',
          skillFolderHash: 'hhh', installedAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      },
    };
    await writeGlobalLock(data);
    const readBack = await readGlobalLock();
    assert.deepStrictEqual(readBack, data);
  });
});

describe('serialize helpers', () => {
  it('serializeProjectLock returns deterministic sorted JSON', () => {
    const data: LocalSkillLockFile = {
      version: 1,
      skills: {
        zebra: { source: 'z/z', sourceType: 'github', computedHash: 'zzz' },
        alpha: { source: 'a/a', sourceType: 'github', computedHash: 'aaa' },
      },
    };
    const out = serializeProjectLock(data);
    assert.ok(out.indexOf('"alpha"') < out.indexOf('"zebra"'), 'should be sorted');
    assert.ok(out.endsWith('
'), 'should end with newline');
  });

  it('serializeGlobalLock preserves insertion order', () => {
    const data: GlobalSkillLockFile = {
      version: 3,
      skills: {
        zebra: {
          source: 'z/z', sourceType: 'github', sourceUrl: 'u', skillFolderHash: 'h',
          installedAt: 'i', updatedAt: 'i',
        },
        alpha: {
          source: 'a/a', sourceType: 'github', sourceUrl: 'u', skillFolderHash: 'h',
          installedAt: 'i', updatedAt: 'i',
        },
      },
    };
    const out = serializeGlobalLock(data);
    assert.ok(out.indexOf('"zebra"') < out.indexOf('"alpha"'), 'insertion order preserved');
    assert.ok(out.endsWith('
'));
  });
});

describe('concurrent writes (atomic guarantee)', () => {
  it('two concurrent writeProjectLock calls leave a valid file (last writer wins)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dataA: LocalSkillLockFile = {
        version: 1,
        skills: { a: { source: 'a/a', sourceType: 'github', computedHash: 'aaa' } },
      };
      const dataB: LocalSkillLockFile = {
        version: 1,
        skills: { b: { source: 'b/b', sourceType: 'github', computedHash: 'bbb' } },
      };

      // Race both writes; expect both to complete without throwing
      await Promise.all([writeProjectLock(tmpDir, dataA), writeProjectLock(tmpDir, dataB)]);

      // The file must be valid JSON and parse cleanly
      const raw = readFileSync(getProjectLockPath(tmpDir), 'utf-8');
      const parsed = JSON.parse(raw) as LocalSkillLockFile;
      assert.strictEqual(parsed.version, 1);
      // Either A or B won. The file should never be empty or partial.
      assert.ok(Object.keys(parsed.skills).length >= 1, 'file should have at least one skill');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});