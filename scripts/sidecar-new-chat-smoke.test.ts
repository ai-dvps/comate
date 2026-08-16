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

    const sessionResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspaceBody.workspace.id}/sessions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: 'First sentence. Second sentence.',
          approvalMode: 'manual',
          backend: 'claude',
        }),
      },
    );
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json() as { name: string };
    assert.equal(session.name, 'First sentence');
  } finally {
    if (handle) {
      await shutdownSidecar(handle, { port, graceMs: 100, logger });
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
