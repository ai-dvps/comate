import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readBoundedResponse } from './bounded-response.js';

describe('bounded response reader', () => {
  it('rejects a declared body larger than the byte limit before reading it', async () => {
    const response = new Response('tiny', { headers: { 'Content-Length': '6' } });

    await assert.rejects(() => readBoundedResponse(response, 5, 'too large'), /too large/);
  });

  it('stops a streamed response when it exceeds the byte limit', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }));

    await assert.rejects(
      () => readBoundedResponse(response, 5, 'too large'),
      /too large/,
    );
  });

  it('combines streamed chunks within the byte limit', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }));

    assert.deepStrictEqual(
      [...await readBoundedResponse(response, 3, 'too large')],
      [1, 2, 3],
    );
  });

  it('accepts exactly the byte limit', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));

    assert.deepStrictEqual([...await readBoundedResponse(response, 3, 'too large')], [1, 2, 3]);
  });

  it('rejects limit plus one without a declared length', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }));

    await assert.rejects(() => readBoundedResponse(response, 3, 'too large'), /too large/);
  });

  it('does not trust a falsely small declared length', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }), { headers: { 'Content-Length': '1' } });

    await assert.rejects(() => readBoundedResponse(response, 3, 'too large'), /too large/);
  });
});
