import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { searchFiles } from './file-search.js';

describe('file search', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('returns matching folders alongside files', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'comate-file-search-test-'));
    await mkdir(path.join(tempDir, 'src', 'components'), { recursive: true });
    await writeFile(path.join(tempDir, 'src', 'components', 'PromptInput.tsx'), 'export {}');

    const result = await searchFiles({
      workspaceRoot: tempDir,
      query: 'components',
      limit: 20,
    });

    assert.ok(result.results.some((entry) => (
      entry.path === 'src/components' && entry.type === 'folder'
    )));
    assert.ok(result.results.some((entry) => (
      entry.path === 'src/components/PromptInput.tsx' && entry.type === 'file'
    )));
  });
});
