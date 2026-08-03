import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  BrowserDirectHttpClient,
  BrowserDirectHttpError,
  type DirectHttpTransport,
  type DirectHttpTransportRequest,
  type DirectHttpTransportResponse,
} from '../browser-direct-http-client.js';

function body(chunks: Array<string | Buffer>): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    },
  };
}

class FakeTransport implements DirectHttpTransport {
  readonly requests: DirectHttpTransportRequest[] = [];
  readonly responses: DirectHttpTransportResponse[] = [];
  async request(input: DirectHttpTransportRequest): Promise<DirectHttpTransportResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error('missing fake response');
    return response;
  }
}

const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
const response = (statusCode: number, headers: Record<string, string> = {}, chunks: Array<string | Buffer> = ['ok']): DirectHttpTransportResponse => ({
  statusCode, headers, body: body(chunks), close: () => {},
});

describe('BrowserDirectHttpClient redirects and pinning', () => {
  it('uses direct pinned HTTPS and ignores ambient proxy variables', async () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    try {
      const transport = new FakeTransport();
      transport.responses.push(response(200, { 'content-type': 'text/plain' }, ['done']));
      const client = new BrowserDirectHttpClient({ resolver, transport });
      const result = await client.request({ url: 'https://api.example.com/v1', authorizedDomain: 'example.com', method: 'GET' });
      assert.equal(result.body.toString(), 'done');
      assert.equal(transport.requests[0].hostname, 'api.example.com');
      assert.equal(transport.requests[0].pinnedAddress, '93.184.216.34');
      assert.equal(transport.requests[0].servername, 'api.example.com');
      assert.equal(transport.requests[0].headers['accept-encoding'], 'identity');
      assert.equal('proxy' in transport.requests[0], false);
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });

  it('implements deliberate redirect method/body semantics', async () => {
    for (const [status, expectedMethod] of [[301, 'GET'], [302, 'GET'], [303, 'GET'], [307, 'POST'], [308, 'POST']] as const) {
      const transport = new FakeTransport();
      transport.responses.push(
        response(status, { location: '/next' }, []),
        response(200, {}, ['ok']),
      );
      const client = new BrowserDirectHttpClient({ resolver, transport });
      await client.request({ url: 'https://api.example.com/start', authorizedDomain: 'example.com', method: 'POST', body: 'payload' });
      assert.equal(transport.requests[1].method, expectedMethod, String(status));
      assert.equal(transport.requests[1].body?.toString(), expectedMethod === 'POST' ? 'payload' : undefined);
    }
  });

  it('revalidates redirects, rejects off-domain targets and loops', async () => {
    const offsite = new FakeTransport();
    offsite.responses.push(response(302, { location: 'https://evil.test/steal' }, []));
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver, transport: offsite }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'destination_not_allowed',
    );
    const loop = new FakeTransport();
    loop.responses.push(response(302, { location: '/b' }, []), response(302, { location: '/' }, []));
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver, transport: loop }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'redirect_loop',
    );
  });

  it('re-resolves every hop and rebuilds broker headers only after validation', async () => {
    let resolves = 0;
    const rebindingResolver = async () => {
      resolves += 1;
      return resolves === 1
        ? [{ address: '93.184.216.34', family: 4 as const }]
        : [{ address: '10.0.0.1', family: 4 as const }];
    };
    const transport = new FakeTransport();
    transport.responses.push(response(302, { location: '/next' }, []));
    let hookCalls = 0;
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver: rebindingResolver, transport }).request({
        url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET',
        prepareHopHeaders: () => ({ authorization: `Bearer generation-${++hookCalls}` }),
      }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'destination_unsafe',
    );
    assert.equal(resolves, 2);
    assert.equal(hookCalls, 1, 'unsafe redirected hop never receives auth-hook headers');
    assert.equal(transport.requests[0].headers.authorization, 'Bearer generation-1');
  });
});

describe('BrowserDirectHttpClient resource limits', () => {
  it('rejects oversized wire and decompressed responses', async () => {
    const wire = new FakeTransport();
    wire.responses.push(response(200, {}, ['1234567890']));
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver, transport: wire, limits: { maxResponseWireBytes: 5 } }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'response_limit_exceeded',
    );

    const compressed = new FakeTransport();
    compressed.responses.push(response(200, { 'content-encoding': 'gzip' }, [gzipSync('x'.repeat(1_000))]));
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver, transport: compressed, limits: { maxResponseDecodedBytes: 100, maxDecompressionRatio: 10 } }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      BrowserDirectHttpError,
    );
  });

  it('propagates aborts/total timeout and enforces concurrency', async () => {
    await assert.rejects(
      new BrowserDirectHttpClient({
        resolver: async () => await new Promise(() => {}),
        transport: new FakeTransport(),
        limits: { totalTimeoutMs: 10 },
      }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'request_timeout',
    );

    const slowBody: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    };
    const slow = new FakeTransport();
    slow.responses.push({ statusCode: 200, headers: {}, body: slowBody, close: () => {} });
    await assert.rejects(
      new BrowserDirectHttpClient({ resolver, transport: slow, limits: { totalTimeoutMs: 10 } }).request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'request_timeout',
    );

    const blocking = new FakeTransport();
    blocking.responses.push({ statusCode: 200, headers: {}, body: slowBody, close: () => {} });
    const controller = new AbortController();
    const client = new BrowserDirectHttpClient({ resolver, transport: blocking, limits: { maxConcurrent: 1, totalTimeoutMs: 1_000 } });
    const first = client.request({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET', signal: controller.signal });
    await assert.rejects(
      client.request({ url: 'https://example.com/other', authorizedDomain: 'example.com', method: 'GET' }),
      (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'concurrency_limit_exceeded',
    );
    controller.abort();
    await assert.rejects(first, (error: unknown) => error instanceof BrowserDirectHttpError && error.code === 'request_aborted');
  });
});
