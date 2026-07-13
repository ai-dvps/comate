import '../test-utils/test-env.js';
/**
 * Run via: 'npx tsx --test src/server/services/analytics-transcript-path.test.ts'
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeProjectDir,
  resolveClaudeProjectsDir,
  resolveProjectPath,
  resolveTranscriptDir,
  statTranscript,
} from './analytics-transcript-path.js';
describe('analytics-transcript-path', () => {
  const ENV_KEYS = ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CONFIG_DIR'] as const;
  const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
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

  // Native-absolute but nonexistent path, so realpath fails and the raw path
  // is encoded as-is on every platform.
  const NONEXISTENT_FOLDER_PATH =
    process.platform === 'win32'
      ? 'C:\\Users\\comate-test-nonexistent\\project'
      : '/Users/comate-test-nonexistent/project';

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('encodeProjectDir', () => {
    it('encodes Unix absolute paths by replacing / with -', () => {
      assert.equal(
        encodeProjectDir('/Users/shunyun/workspace/ai/claude-code-gui'),
        '-Users-shunyun-workspace-ai-claude-code-gui',
      );
    });

    it('encodes Windows absolute paths by replacing both backslashes and the drive colon', () => {
      assert.equal(
        encodeProjectDir('C:\\Users\\shunyun\\workspace\\ai\\claude-code-gui'),
        'C--Users-shunyun-workspace-ai-claude-code-gui',
      );
    });

    it('encodes another Windows drive letter correctly', () => {
      assert.equal(
        encodeProjectDir('D:\\projects\\any-project'),
        'D--projects-any-project',
      );
    });

    it('handles mixed forward and backward slashes', () => {
      assert.equal(
        encodeProjectDir('C:/Users\\shunyun/project'),
        'C--Users-shunyun-project',
      );
    });

    it('handles trailing separators', () => {
      assert.equal(
        encodeProjectDir('/Users/shunyun/project/'),
        '-Users-shunyun-project-',
      );
      assert.equal(
        encodeProjectDir('C:\\Users\\shunyun\\project\\'),
        'C--Users-shunyun-project-',
      );
    });

    // The SDK's `Fo` replaces EVERY non-alphanumeric character, not just
    // separators and the drive colon. Windows paths routinely contain dots
    // (user names like john.doe), spaces, underscores, or CJK characters —
    // all of which Claude Code turns into '-'. If our encoding keeps them,
    // the resolved transcript directory never exists and analytics stays
    // empty.
    it('replaces dots, spaces, and underscores like the SDK does', () => {
      assert.equal(
        encodeProjectDir('/Users/john.doe/my_project files'),
        '-Users-john-doe-my-project-files',
      );
    });

    it('replaces CJK characters in Windows user names', () => {
      assert.equal(
        encodeProjectDir('C:\\Users\\张三\\project'),
        'C--Users----project',
      );
    });

    it('truncates names longer than 200 chars with a base36 hash suffix (SDK Fo)', () => {
      // Expected values computed from the SDK algorithm:
      // `${encoded.slice(0,200)}-${Math.abs(javaHash(preEncodingPath)).toString(36)}`
      assert.equal(
        encodeProjectDir('/' + 'a'.repeat(250)),
        '-' + 'a'.repeat(199) + '-feo44x',
      );
      assert.equal(
        encodeProjectDir('C:\\Users\\' + 'b'.repeat(250)),
        'C--Users-' + 'b'.repeat(191) + '-lekbxj',
      );
    });

    it('does not truncate at exactly 200 chars, truncates at 201 (SDK Ss boundary)', () => {
      assert.equal(encodeProjectDir('a'.repeat(200)), 'a'.repeat(200));
      assert.equal(encodeProjectDir('a'.repeat(201)), 'a'.repeat(200) + '-rkvsv5');
    });
  });

  describe('resolveProjectPath', () => {
    it('strips trailing separators like path.resolve', () => {
      const dir = mkdtempSync(join(tmpdir(), 'analytics-ws-'));
      const resolved = resolveProjectPath(dir + '/');
      assert.ok(!resolved.endsWith('/'), `expected no trailing separator, got ${resolved}`);
      assert.equal(resolved, realpathSync(dir));

      rmSync(dir, { recursive: true, force: true });
    });

    it('resolves symlinks to the real directory Claude Code sees', () => {
      const target = mkdtempSync(join(tmpdir(), 'analytics-ws-target-'));
      const link = join(tmpdir(), `analytics-ws-link-${process.pid}`);
      symlinkSync(target, link);

      assert.equal(resolveProjectPath(link), realpathSync(target));

      unlinkSync(link);
      rmSync(target, { recursive: true, force: true });
    });

    it('falls back to the unresolved path when realpath fails', () => {
      const missing = join(tmpdir(), 'analytics-does-not-exist-xyz');
      assert.equal(resolveProjectPath(missing), missing);
    });
  });

  describe('resolveClaudeProjectsDir', () => {
    it('resolves to HOME/.claude/projects when HOME is set', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOME = home;
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(resolveClaudeProjectsDir(), join(home, '.claude', 'projects'));

      rmSync(home, { recursive: true, force: true });
    });

    it('prefers USERPROFILE on Windows when it exists', () => {
      const userProfile = mkdtempSync(join(tmpdir(), 'analytics-userprofile-'));
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.USERPROFILE = userProfile;
      process.env.HOME = home;
      mkdirSync(join(userProfile, '.claude', 'projects'), { recursive: true });
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(
        resolveClaudeProjectsDir(),
        join(userProfile, '.claude', 'projects'),
      );

      rmSync(userProfile, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('falls back to HOMEDRIVE+HOMEPATH when set', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOMEDRIVE = home.slice(0, 2); // e.g. "/V"
      process.env.HOMEPATH = home.slice(2);
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(resolveClaudeProjectsDir(), join(home, '.claude', 'projects'));

      rmSync(home, { recursive: true, force: true });
    });

    it('prefers CLAUDE_CONFIG_DIR when set (SDK Xt parity)', () => {
      const configDir = mkdtempSync(join(tmpdir(), 'analytics-config-'));
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.CLAUDE_CONFIG_DIR = configDir;
      process.env.HOME = home;
      mkdirSync(join(configDir, 'projects'), { recursive: true });
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(resolveClaudeProjectsDir(), join(configDir, 'projects'));

      rmSync(configDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('honors CLAUDE_CONFIG_DIR unconditionally, even without a projects dir yet', () => {
      // An explicit CLAUDE_CONFIG_DIR declares where Claude Code writes; the
      // SDK uses it as-is. Falling back to ~/.claude/projects would read
      // transcripts from the wrong installation.
      const configDir = mkdtempSync(join(tmpdir(), 'analytics-config-'));
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.CLAUDE_CONFIG_DIR = configDir;
      process.env.HOME = home;
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(resolveClaudeProjectsDir(), join(configDir, 'projects'));

      rmSync(configDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('NFC-normalizes CLAUDE_CONFIG_DIR like SDK Xt (all platforms)', () => {
      // 'café' holds an NFD é; Xt normalizes the config dir
      // unconditionally, so the projects root must come back NFC.
      process.env.CLAUDE_CONFIG_DIR = '/tmp/café';
      assert.equal(resolveClaudeProjectsDir(), join('/tmp/café', 'projects'));
    });

    it('treats an empty CLAUDE_CONFIG_DIR as unset (deliberate deviation from SDK Xt)', () => {
      // Xt's `??` would adopt the empty string, yielding a cwd-relative
      // 'projects' root — meaningless for this server process. Falling back
      // to the home candidates is the useful behavior.
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.CLAUDE_CONFIG_DIR = '';
      process.env.HOME = home;
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

      assert.equal(resolveClaudeProjectsDir(), join(home, '.claude', 'projects'));

      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('resolveTranscriptDir', () => {
    it('resolves the encoded project directory under .claude/projects', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOME = home;
      const projectsDir = join(home, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });

      const folderPath = NONEXISTENT_FOLDER_PATH;
      const expected = join(projectsDir, encodeProjectDir(folderPath));
      assert.equal(resolveTranscriptDir(folderPath), expected);

      rmSync(home, { recursive: true, force: true });
    });

    it('encodes the realpath-resolved workspace dir (matches Claude Code on disk)', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOME = home;
      const projectsDir = join(home, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });

      // tmpdir() on macOS is a /var symlink to /private/var — Claude Code
      // realpaths before encoding, so the on-disk dir uses the resolved path.
      const workspace = mkdtempSync(join(tmpdir(), 'analytics-ws.'));
      const expected = join(projectsDir, encodeProjectDir(realpathSync(workspace)));
      assert.equal(resolveTranscriptDir(workspace), expected);

      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('statTranscript', () => {
    it('returns exists=true with mtime and size for an existing file', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      const filePath = join(home, 'test.jsonl');
      writeFileSync(filePath, 'line\n');

      const stat = statTranscript(filePath);
      assert.equal(stat.exists, true);
      assert.ok('mtimeMs' in stat && stat.mtimeMs > 0);
      assert.ok('size' in stat && stat.size === 5);

      rmSync(home, { recursive: true, force: true });
    });

    it('returns exists=false for a missing file', () => {
      const stat = statTranscript('/nonexistent/path/file.jsonl');
      assert.deepEqual(stat, { exists: false });
    });
  });
});

