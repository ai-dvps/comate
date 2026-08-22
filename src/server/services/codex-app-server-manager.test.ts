import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CodexAppServerManager } from './codex-app-server-manager.js';

describe('CodexAppServerManager', () => {
  it('initializes the pinned server and lists an isolated native history', async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), 'comate-manager-codex-home-'));
    const manager = new CodexAppServerManager();
    try {
      const response = await manager.request<{ data: unknown[] }>('thread/list', {
        limit: 1,
        useStateDbOnly: true,
      });
      assert.deepEqual(response.data, []);
    } finally {
      await manager.stop();
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
