import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildSidecarEnv,
  resolveResourceDir,
  resolveSidecarBinaryPath,
  shutdownSidecar,
  spawnSidecar,
  type SidecarHandle,
} from '../electron/sidecar.js';

const logger = { info: () => {}, error: () => {} };

test('packaged sidecar creates a New Chat session from a prose prompt without crashing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comate-sidecar-new-chat-'));
  let handle: SidecarHandle | undefined;
  let port: number | undefined;
  try {
    const pathEnv = {
      isPackaged: false,
      resourcesPath: '',
      repoRoot: process.cwd(),
      platform: process.platform,
      arch: process.arch,
    };
    handle = spawnSidecar({
      binaryPath: resolveSidecarBinaryPath(pathEnv),
      env: buildSidecarEnv({ dataDir, resourceDir: resolveResourceDir(pathEnv) }),
      logger,
    });

    const ready = await handle.ready;
    port = ready.port;
    const headers = {
      Authorization: `Bearer ${ready.desktopToken}`,
      'Content-Type': 'application/json',
    };
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'sidecar-smoke', folderPath: process.cwd() }),
    });
    assert.equal(workspaceResponse.status, 201);
    const workspaceBody = await workspaceResponse.json() as { workspace: { id: string } };

    // The title-derivation path must never touch Intl.Segmenter: the packaged
    // (@yao-pkg/pkg) runtime segfaults inside segment() for every granularity.
    // These cases pin the two shapes that reach the segmenter through
    // grapheme-aware width/slice helpers — non-ASCII text and text long enough
    // to truncate. An English sentence alone slips past both (ASCII fast path,
    // no truncation), which is how the packaged crash shipped once already.
    const cases: Array<{ prompt: string; expected: string }> = [
      { prompt: 'First sentence. Second sentence.', expected: 'First sentence' },
      { prompt: '今天星期几', expected: '今天星期几' },
      { prompt: '修复登录后的重定向循环。请检查路由守卫。', expected: '修复登录后的重定向循环' },
    ];
    for (const { prompt, expected } of cases) {
      const sessionResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspaceBody.workspace.id}/sessions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ prompt, approvalMode: 'manual', backend: 'claude' }),
        },
      );
      assert.equal(sessionResponse.status, 201, `session creation failed for prompt ${JSON.stringify(prompt)}`);
      const session = await sessionResponse.json() as { name: string };
      assert.equal(session.name, expected);
    }

    const longPrompt = `New Chat ${'title-'.repeat(30)} truncation check`;
    const longResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspaceBody.workspace.id}/sessions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: longPrompt, approvalMode: 'manual', backend: 'claude' }),
      },
    );
    assert.equal(longResponse.status, 201, 'session creation failed for a truncating prompt');
    const longSession = await longResponse.json() as { name: string };
    assert.ok(longSession.name.endsWith('…'), `expected a truncated title, got ${JSON.stringify(longSession.name)}`);
  } finally {
    if (handle) {
      await shutdownSidecar(handle, { port, graceMs: 100, logger });
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
