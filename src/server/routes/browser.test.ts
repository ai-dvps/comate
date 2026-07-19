import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createBrowserRouter, type BrowserRouteDeps } from './browser.js';

/**
 * /api/browser/:sessionId/viewer-url contract (U6, KTD-7): the viewer URL is
 * constructed server-side only. Sessions without a live browser (unknown,
 * starting, session_lost) get `{ url: null }` so the panel renders its
 * empty/starting/lost states; a live session gets the proxy URL verbatim.
 */

type Handler = (req: unknown, res: unknown) => void;

function getViewerUrlHandler(deps: Partial<BrowserRouteDeps>): Handler {
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
    if (layer.route && layer.route.path === '/:sessionId/viewer-url' && layer.route.methods.get) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error('viewer-url handler not found');
}

function createMockReq(sessionId: string) {
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

const VIEWER_URL =
  'http://127.0.0.1:43210/s/abcdefghijklmnopqrstuvwxyzabcdef/v1/sessions/debug?interactive=true&theme=dark&showControls=true';

describe('browser viewer-url route', { concurrency: false }, () => {
  it('returns the server-constructed URL for a live session', () => {
    const handler = getViewerUrlHandler({
      hasLiveSession: () => true,
      getViewerUrl: () => VIEWER_URL,
    });
    const res = createMockRes();
    handler(createMockReq('sess-1'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { url: VIEWER_URL });
  });

  it('returns { url: null } when the session is unknown', () => {
    const handler = getViewerUrlHandler({
      hasLiveSession: () => false,
      getViewerUrl: () => {
        throw new Error('must not be called for a dead session');
      },
    });
    const res = createMockRes();
    handler(createMockReq('nope'), res);
    assert.deepEqual(res.jsonBody, { url: null });
  });

  it('returns { url: null } when the proxy has no URL for a live session', () => {
    const handler = getViewerUrlHandler({
      hasLiveSession: () => true,
      getViewerUrl: () => undefined,
    });
    const res = createMockRes();
    handler(createMockReq('sess-2'), res);
    assert.deepEqual(res.jsonBody, { url: null });
  });

  it('never logs or mutates the URL — it passes the token-bearing string through verbatim', () => {
    const handler = getViewerUrlHandler({
      hasLiveSession: () => true,
      getViewerUrl: (sessionId) => `http://127.0.0.1:1/s/token-for-${sessionId}/v1/sessions/debug?x=1`,
    });
    const res = createMockRes();
    handler(createMockReq('sess-3'), res);
    const body = res.jsonBody as { url: string };
    assert.equal(body.url, 'http://127.0.0.1:1/s/token-for-sess-3/v1/sessions/debug?x=1');
  });
});
