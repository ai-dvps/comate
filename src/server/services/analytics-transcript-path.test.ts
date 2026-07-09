import '../test-utils/test-env.js';
/**
 * Run via: 'npx tsx --test src/server/services/analytics-transcript-path.test.ts'
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeProjectDir,
  resolveClaudeProjectsDir,
  resolveTranscriptDir,
  resolveTranscriptFile,
  statTranscript,
} from './analytics-transcript-path.js';
describe('analytics-transcript-path', () => {
  const originalEnv = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  beforeEach(() => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
  });

  afterEach(() => {
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    process.env.HOME = originalEnv.HOME;
    process.env.HOMEDRIVE = originalEnv.HOMEDRIVE;
    process.env.HOMEPATH = originalEnv.HOMEPATH;
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

  });

  describe('resolveTranscriptDir', () => {
    it('resolves the encoded project directory under .claude/projects', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOME = home;
      const projectsDir = join(home, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });

      const folderPath = 'C:\\Users\\shunyun\\project';
      const expected = join(projectsDir, 'C--Users-shunyun-project');
      assert.equal(resolveTranscriptDir(folderPath), expected);

      rmSync(home, { recursive: true, force: true });
    });

  });

  describe('resolveTranscriptFile', () => {
    it('resolves the full transcript JSONL path for a session', () => {
      const home = mkdtempSync(join(tmpdir(), 'analytics-home-'));
      process.env.HOME = home;
      const projectsDir = join(home, '.claude', 'projects');
      mkdirSync(projectsDir, { recursive: true });

      const folderPath = 'C:\\Users\\shunyun\\project';
      const expected = join(
        projectsDir,
        'C--Users-shunyun-project',
        'sess-1.jsonl',
      );
      assert.equal(resolveTranscriptFile(folderPath, 'sess-1'), expected);

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

