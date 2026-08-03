import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserNetworkCaptureManager,
  BrowserNetworkCaptureError,
  type BrowserNetworkCaptureTransport,
  type CdpEventEnvelope,
} from '../browser-network-capture.js';

class FakeTransport implements BrowserNetworkCaptureTransport {
  readonly primarySessionId = 'page';
  readonly commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  private readonly eventListeners = new Set<(event: CdpEventEnvelope) => void>();
  private readonly closeListeners = new Set<() => void>();
  bodyByKey = new Map<string, { body: string; base64Encoded: boolean } | Error>();
  starts = 0;
  stops = 0;

  async start(): Promise<void> { this.starts += 1; }
  stop(): void { this.stops += 1; }
  onEvent(listener: (event: CdpEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  async send<T>(method: string, params: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.commands.push({ method, params, sessionId });
    if (method === 'Network.getResponseBody') {
      const key = `${sessionId ?? ''}:${String(params.requestId)}`;
      const result = this.bodyByKey.get(key);
      if (result instanceof Error) throw result;
      return (result ?? { body: '', base64Encoded: false }) as T;
    }
    return {} as T;
  }
  emit(method: string, params: Record<string, unknown>, sessionId = this.primarySessionId): void {
    for (const listener of [...this.eventListeners]) listener({ method, params, sessionId });
  }
  close(): void { for (const listener of [...this.closeListeners]) listener(); }
}

function request(requestId: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    requestId,
    request: { url, method: 'GET', headers: { accept: 'application/json' } },
    type: 'Fetch',
    timestamp: 1,
    ...extra,
  };
}

function response(requestId: string, status = 200) {
  return {
    requestId,
    response: {
      url: 'https://example.com/api',
      status,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      mimeType: 'application/json',
    },
  };
}

function manager(transport: FakeTransport, overrides = {}) {
  return new BrowserNetworkCaptureManager(transport, {
    quietMs: 2,
    hardDeadlineMs: 40,
    ...overrides,
  });
}

describe('BrowserNetworkCaptureManager', () => {
  it('keys identical request IDs by session and reads bodies after loadingFinished', async () => {
    const transport = new FakeTransport();
    transport.bodyByKey.set('frame-a:1', { body: '{"a":1}', base64Encoded: false });
    transport.bodyByKey.set('worker-b:1', { body: '{"b":2}', base64Encoded: false });
    const capture = manager(transport);
    await capture.start();
    for (const session of ['frame-a', 'worker-b']) {
      transport.emit('Network.requestWillBeSent', request('1', `https://example.com/${session}`), session);
      transport.emit('Network.responseReceived', response('1'), session);
      transport.emit('Network.loadingFinished', { requestId: '1' }, session);
    }
    const result = await capture.stop();
    assert.equal(result.chains.length, 2);
    assert.deepEqual(result.chains.map((chain) => chain.sessionId).sort(), ['frame-a', 'worker-b']);
    assert.deepEqual(result.chains.map((chain) => chain.hops[0].responseBody?.body).sort(), ['{"a":1}', '{"b":2}']);
  });

  it('reads a response body only once when loadingFinished is duplicated', async () => {
    const transport = new FakeTransport();
    const capture = manager(transport);
    await capture.start();
    transport.emit('Network.requestWillBeSent', request('duplicate', 'https://example.com/api'));
    transport.emit('Network.responseReceived', response('duplicate'));
    transport.emit('Network.loadingFinished', { requestId: 'duplicate' });
    transport.emit('Network.loadingFinished', { requestId: 'duplicate' });
    await capture.stop();
    assert.equal(
      transport.commands.filter((command) =>
        command.method === 'Network.getResponseBody' && command.params.requestId === 'duplicate').length,
      1,
    );
  });

  it('orders redirect hops and prefers authoritative extra-info status regardless of arrival order', async () => {
    const transport = new FakeTransport();
    transport.bodyByKey.set('page:r', { body: '{"done":true}', base64Encoded: false });
    const capture = manager(transport);
    await capture.start();
    transport.emit('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 304, headers: { etag: 'x' } });
    transport.emit('Network.requestWillBeSent', request('r', 'https://example.com/old'));
    transport.emit('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { 'x-extra': 'one' } });
    transport.emit('Network.requestWillBeSent', request('r', 'https://example.com/new', {
      redirectResponse: { url: 'https://example.com/old', status: 302, statusText: 'Found', headers: { location: '/new' } },
    }));
    transport.emit('Network.responseReceived', response('r', 200));
    transport.emit('Network.loadingFinished', { requestId: 'r' });
    const result = await capture.stop();
    assert.equal(result.chains[0].hops.length, 2);
    assert.equal(result.chains[0].hops[0].response?.status, 304);
    assert.equal(result.chains[0].hops[0].request.url, 'https://example.com/old');
    assert.equal(result.chains[0].hops[1].request.url, 'https://example.com/new');
    assert.equal(result.chains[0].hops[0].requestExtraHeaders?.['x-extra'], 'one');
  });

  it('closes admission at stop but drains already-admitted chains', async () => {
    const transport = new FakeTransport();
    const capture = manager(transport);
    await capture.start();
    transport.emit('Network.requestWillBeSent', request('before', 'https://example.com/before'));
    const stopping = capture.stop();
    transport.emit('Network.requestWillBeSent', request('after', 'https://example.com/after'));
    transport.emit('Network.responseReceived', response('before'));
    transport.emit('Network.loadingFinished', { requestId: 'before' });
    const result = await stopping;
    assert.deepEqual(result.chains.map((chain) => chain.requestId), ['before']);
  });

  it('marks body eviction, loading failure, target detach, and hard deadline as incomplete', async () => {
    const transport = new FakeTransport();
    transport.bodyByKey.set('page:evicted', new Error('No resource with given identifier'));
    const capture = manager(transport, { hardDeadlineMs: 15 });
    await capture.start();
    transport.emit('Network.requestWillBeSent', request('evicted', 'https://example.com/a'));
    transport.emit('Network.responseReceived', response('evicted'));
    transport.emit('Network.loadingFinished', { requestId: 'evicted' });
    transport.emit('Network.requestWillBeSent', request('cors', 'https://example.com/b'));
    transport.emit('Network.loadingFailed', { requestId: 'cors', errorText: 'CORS', blockedReason: 'cors' });
    transport.emit('Network.requestWillBeSent', request('detached', 'https://example.com/c'), 'frame');
    transport.emit('Target.detachedFromTarget', { sessionId: 'frame' });
    transport.emit('Network.requestWillBeSent', request('long', 'https://example.com/d'));
    const result = await capture.stop();
    const reasons = result.chains.flatMap((chain) => chain.incompleteReasons);
    assert.ok(reasons.includes('body_unavailable'));
    assert.ok(reasons.includes('loading_failed'));
    assert.ok(reasons.includes('target_detached'));
    assert.ok(reasons.includes('deadline_exceeded'));
  });

  it('rejects concurrent starts and aborts deterministically on disconnect', async () => {
    const transport = new FakeTransport();
    const capture = manager(transport);
    await capture.start();
    await assert.rejects(capture.start(), (error: unknown) =>
      error instanceof BrowserNetworkCaptureError && error.code === 'capture_already_active');
    transport.emit('Network.requestWillBeSent', request('1', 'https://example.com'));
    const stopping = capture.stop();
    transport.close();
    const result = await stopping;
    assert.equal(result.state, 'aborted');
    assert.ok(result.incompleteReasons.includes('connection_closed'));
    assert.equal(transport.stops, 1);
  });

  it('bounds forgotten noisy captures and retained response bodies', async () => {
    const transport = new FakeTransport();
    transport.bodyByKey.set('page:first', { body: '12345', base64Encoded: false });
    transport.bodyByKey.set('page:second', { body: '67890', base64Encoded: false });
    const capture = manager(transport, {
      recordingDeadlineMs: 10,
      maxChains: 3,
      maxHopsPerChain: 1,
      maxRetainedBodyBytes: 5,
    });
    await capture.start();
    for (const id of ['first', 'second']) {
      transport.emit('Network.requestWillBeSent', request(id, `https://example.com/${id}`));
      transport.emit('Network.responseReceived', response(id));
      transport.emit('Network.loadingFinished', { requestId: id });
    }
    transport.emit('Network.requestWillBeSent', request('long', 'https://example.com/long'));
    transport.emit('Network.requestWillBeSent', request('overflow', 'https://example.com/overflow'));
    const result = await new Promise<Awaited<ReturnType<typeof capture.stop>>>((resolve) => {
      const poll = setInterval(() => {
        if (capture.state === 'draining') {
          clearInterval(poll);
          void capture.stop().then(resolve);
        }
      }, 1);
    });
    assert.equal(result.chains.length, 3);
    assert.equal(result.chains.filter((chain) => chain.hops[0].responseBody).length, 1);
    assert.ok(result.incompleteReasons.includes('capture_limit_exceeded'));
    assert.equal(transport.stops, 1);
  });
});
