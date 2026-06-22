import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSendFilePath } from './wecom-send-file-policy.js';

describe('validateSendFilePath', { concurrency: false }, () => {
  let tmpDir = '';

  before(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-send-file-policy-')));

    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'report.pdf'), 'report content');

    fs.mkdirSync(path.join(tmpDir, 'data', 'ZhangWei'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'ZhangWei', 'private.pdf'), 'private content');

    fs.mkdirSync(path.join(tmpDir, 'data', 'LiSi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'LiSi', 'secret.pdf'), 'secret content');

    // Symlink inside workspace pointing outside
    fs.symlinkSync('/etc/passwd', path.join(tmpDir, 'outside-link'));

    // Directory path
    fs.mkdirSync(path.join(tmpDir, 'empty-dir'), { recursive: true });
  });

  it('allows a shared workspace file', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', 'docs/report.pdf');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, undefined);
    assert.strictEqual(result.relativePath, path.join('docs', 'report.pdf'));
    assert.strictEqual(result.absolutePath, path.join(tmpDir, 'docs', 'report.pdf'));
  });

  it('allows a file inside the target user data folder', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', 'data/ZhangWei/private.pdf');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.relativePath, path.join('data', 'ZhangWei', 'private.pdf'));
  });

  it('denies a file inside another user data folder', () => {
    const result = validateSendFilePath(tmpDir, 'LiSi', 'data/ZhangWei/private.pdf');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'other-user-dir');
  });

  it('is case-insensitive for data folder matching', () => {
    const result = validateSendFilePath(tmpDir, 'zhangwei', 'data/ZhangWei/private.pdf');
    assert.strictEqual(result.allowed, true);
  });

  it('denies paths with parent traversal escaping the workspace', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', '../etc/passwd');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'outside-workspace');
  });

  it('denies symlinks pointing outside the workspace', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', 'outside-link');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'outside-workspace');
  });

  it('denies directory paths', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', 'empty-dir');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'not-a-file');
  });

  it('denies absolute paths outside the workspace', () => {
    const result = validateSendFilePath(tmpDir, 'ZhangWei', '/etc/passwd');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'outside-workspace');
  });

  it('denies empty or non-string paths', () => {
    assert.strictEqual(validateSendFilePath(tmpDir, 'ZhangWei', '').allowed, false);
    assert.strictEqual(validateSendFilePath(tmpDir, 'ZhangWei', '').reason, 'invalid-path');
    assert.strictEqual(validateSendFilePath(tmpDir, 'ZhangWei', 123 as unknown as string).allowed, false);
    assert.strictEqual(
      validateSendFilePath(tmpDir, 'ZhangWei', 123 as unknown as string).reason,
      'invalid-path',
    );
  });

  it('denies files directly under data without a user folder', () => {
    fs.writeFileSync(path.join(tmpDir, 'data', 'orphan.pdf'), 'orphan');
    const result = validateSendFilePath(tmpDir, 'ZhangWei', 'data/orphan.pdf');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'other-user-dir');
  });
});
