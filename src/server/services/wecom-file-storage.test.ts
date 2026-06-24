import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveMediaFile } from './wecom-file-storage.js';

describe('saveMediaFile', { concurrency: false }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wecom-storage-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('saves file to a new folder and creates the directory', async () => {
    const buffer = Buffer.from('hello world');
    const result = await saveMediaFile(tempDir, 'user-1', buffer, 'report.pdf');

    assert.strictEqual(result, `data${path.sep}user-1${path.sep}report.pdf`);

    const filePath = path.join(tempDir, 'data', 'user-1', 'report.pdf');
    const content = await fsPromises.readFile(filePath);
    assert.deepStrictEqual(content, buffer);
  });

  it('saves file to an existing folder without error', async () => {
    const dir = path.join(tempDir, 'data', 'existing-user');
    await fsPromises.mkdir(dir, { recursive: true });

    const buffer = Buffer.from('data');
    const result = await saveMediaFile(tempDir, 'existing-user', buffer, 'notes.txt');

    assert.strictEqual(result, `data${path.sep}existing-user${path.sep}notes.txt`);

    const content = await fsPromises.readFile(path.join(dir, 'notes.txt'));
    assert.deepStrictEqual(content, buffer);
  });

  it('handles collision by adding timestamp suffix', async () => {
    const dir = path.join(tempDir, 'data', 'user-1');
    const originalBuffer = Buffer.from('original');
    const newBuffer = Buffer.from('replacement');

    // Save the original file
    await saveMediaFile(tempDir, 'user-1', originalBuffer, 'report.pdf');

    // Save again with the same filename
    const result = await saveMediaFile(tempDir, 'user-1', newBuffer, 'report.pdf');

    // Result should have a timestamp suffix before .pdf
    assert.match(result, /^data\/user-1\/report-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.pdf$/);

    // Original file should remain untouched
    const originalContent = await fsPromises.readFile(path.join(dir, 'report.pdf'));
    assert.deepStrictEqual(originalContent, originalBuffer);

    // New file should have the replacement content
    const timestampPattern = /\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/;
    const match = result.match(timestampPattern);
    assert.ok(match);
    const newFilePath = path.join(dir, `report-${match[0]}.pdf`);
    const newContent = await fsPromises.readFile(newFilePath);
    assert.deepStrictEqual(newContent, newBuffer);
  });

  it('handles collision for a file with no extension', async () => {
    const originalBuffer = Buffer.from('original');
    const newBuffer = Buffer.from('replacement');

    await saveMediaFile(tempDir, 'user-1', originalBuffer, 'data');

    const result = await saveMediaFile(tempDir, 'user-1', newBuffer, 'data');

    // No extension — timestamp appended to end
    assert.match(result, /^data\/user-1\/data-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  it('handles filename with multiple dots (timestamp before last dot)', async () => {
    const originalBuffer = Buffer.from('original');
    const newBuffer = Buffer.from('replacement');

    await saveMediaFile(tempDir, 'user-1', originalBuffer, 'archive.tar.gz');

    const result = await saveMediaFile(tempDir, 'user-1', newBuffer, 'archive.tar.gz');

    // Timestamp goes before the last dot: archive.tar-<ts>.gz
    assert.match(result, /^data\/user-1\/archive\.tar-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.gz$/);
  });

  it('throws when target file path is outside the workspace', async () => {
    const buffer = Buffer.from('evil');

    // Use a filename with path traversal to escape workspace
    await assert.rejects(
      () => saveMediaFile(tempDir, '../../../etc', buffer, 'passwd'),
      /outside the workspace/,
    );

    // Verify no file was created outside the workspace
    const etcPath = path.resolve(tempDir, '../../../etc/passwd');
    await assert.rejects(() => fsPromises.access(etcPath));
  });

  it('throws when user folder contains path traversal', async () => {
    const buffer = Buffer.from('traversal');

    await assert.rejects(
      () => saveMediaFile(tempDir, '../../escape', buffer, 'file.txt'),
      /outside the workspace/,
    );

    // Ensure no file was written outside workspace
    const escapePath = path.join(path.resolve(tempDir), '..', 'escape', 'file.txt');
    await assert.rejects(() => fsPromises.access(escapePath));
  });

  it('saves file under an encrypted user ID folder name', async () => {
    const buffer = Buffer.from('encrypted user data');
    const encryptedId = 'a1b2c3d4e5f6g7h8i9j0';

    const result = await saveMediaFile(tempDir, encryptedId, buffer, 'document.docx');

    assert.strictEqual(result, `data${path.sep}${encryptedId}${path.sep}document.docx`);

    const filePath = path.join(tempDir, 'data', encryptedId, 'document.docx');
    const content = await fsPromises.readFile(filePath);
    assert.deepStrictEqual(content, buffer);
  });
});