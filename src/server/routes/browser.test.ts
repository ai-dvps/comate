import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createBrowserRouter, type BrowserRouteDeps } from './browser.js';

/**
 * /api/browser/:sessionId/retry contract (U8/U9): manual retry for a lost
 * native browser session. The viewer-url endpoint left with the iframe
 * viewer in U9 — the panel is backed by the shell's WebContentsView.
 */

type Handler = (req: unknown, res: unknown) => void;

function getRetryHandler(deps: Partial<BrowserRouteDeps>): Handler {
  const router = createBrowserRouter(deps);
  const layers = (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    }
  ).stack;
  for (const layer of layers) {
    if (layer.route && layer.route.path === '/:sessionId/retry' && layer.route.methods.post) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error('retry handler not found');
}

function createMockReq(sessionId: string | undefined) {
  return { params: { sessionId } };
}

function createMockRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
    },
  };
}

async function flush(): Promise<void> {
  // The handler resolves via .then/.catch — let the microtask queue drain.
  await new Promise((resolve) => setImmediate(resolve));
}

describe('browser retry route', { concurrency: false }, () => {
  it('answers { ok: true, rebuilding } from the service result', async () => {
    let seen: string | undefined;
    const handler = getRetryHandler({
      retrySession: async (sessionId) => {
        seen = sessionId;
        return { rebuilding: true };
      },
    });
    const res = createMockRes();
    handler(createMockReq('sess-1'), res);
    await flush();
    assert.equal(seen, 'sess-1');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { ok: true, rebuilding: true });
  });

  it('answers rebuilding: false for a live or unknown session (idempotent no-op)', async () => {
    const handler = getRetryHandler({
      retrySession: async () => ({ rebuilding: false }),
    });
    const res = createMockRes();
    handler(createMockReq('sess-live'), res);
    await flush();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { ok: true, rebuilding: false });
  });

  it('answers 400 when the session id is missing', async () => {
    const handler = getRetryHandler({
      retrySession: async () => {
        throw new Error('must not be called without a session id');
      },
    });
    const res = createMockRes();
    handler(createMockReq(undefined), res);
    await flush();
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.jsonBody, { ok: false, error: 'session id required' });
  });

  it('answers 500 with the error message when the rebuild fails', async () => {
    const handler = getRetryHandler({
      retrySession: async () => {
        throw new Error('control channel is unreachable');
      },
    });
    const res = createMockRes();
    handler(createMockReq('sess-2'), res);
    await flush();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.jsonBody, { ok: false, error: 'control channel is unreachable' });
  });
});
