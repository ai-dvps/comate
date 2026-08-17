import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SendMessagePayload } from '../websocket/types.js';

describe('multimodal message contract', () => {
  it('keeps the client and server message vocabulary byte-identical', async () => {
    const [client, server] = await Promise.all([
      readFile(resolve('src/client/types/message.ts'), 'utf8'),
      readFile(resolve('src/server/types/message.ts'), 'utf8'),
    ]);
    assert.equal(client, server);
  });

  it('preserves the legacy text-only send payload', () => {
    const payload: SendMessagePayload = {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      clientTurnId: 'turn-1',
      content: 'plain text',
    };
    assert.equal(payload.content, 'plain text');
    assert.equal(payload.images, undefined);
  });

  it('preserves declared image ordering adjacent to optional text', () => {
    const payload: SendMessagePayload = {
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      clientTurnId: 'turn-1',
      content: '',
      images: [
        { id: 'second', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 },
        { id: 'first', mediaType: 'image/jpeg', data: '/9g=', width: 1, height: 1 },
      ],
    };
    assert.deepEqual(payload.images?.map((image) => image.id), ['second', 'first']);
  });
});
