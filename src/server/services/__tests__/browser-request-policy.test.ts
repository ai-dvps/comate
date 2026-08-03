import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserRequestPolicyError,
  authorizeBrowserRequest,
  isPublicIpAddress,
  resolveSafeDestination,
  siteBoundaryForUrl,
} from '../browser-request-policy.js';

describe('browser request destination policy', () => {
  it('normalizes IDN/case/trailing dots and honors private PSL tenant boundaries', () => {
    assert.equal(siteBoundaryForUrl('https://BÜCHER.de./x'), 'xn--bcher-kva.de');
    assert.equal(siteBoundaryForUrl('https://User.GitHub.io./'), 'user.github.io');
    const request = authorizeBrowserRequest({
      url: 'https://API.BÜCHER.de./v1?q=1',
      authorizedDomain: 'xn--bcher-kva.de',
      method: 'get',
      headers: { accept: 'application/json' },
    });
    assert.equal(request.url.hostname, 'api.xn--bcher-kva.de');
    assert.throws(
      () => authorizeBrowserRequest({ url: 'https://other.github.io/', authorizedDomain: 'user.github.io', method: 'GET' }),
      (error: unknown) => error instanceof BrowserRequestPolicyError && error.code === 'destination_not_allowed',
    );
  });

  it('rejects unsafe URL shapes, hosts, ports, and methods', () => {
    const cases = [
      ['http://example.com/', 'GET'],
      ['https://user:pass@example.com/', 'GET'],
      ['https://example.com/#secret', 'GET'],
      ['https://127.0.0.1/', 'GET'],
      ['https://[::1]/', 'GET'],
      ['https://example.com:8443/', 'GET'],
      ['https://example.com/', 'CONNECT'],
      ['https://example.com/', 'TRACE'],
    ] as const;
    for (const [url, method] of cases) {
      assert.throws(
        () => authorizeBrowserRequest({ url, authorizedDomain: 'example.com', method }),
        BrowserRequestPolicyError,
        `${method} ${url}`,
      );
    }
  });

  it('rejects duplicate, credential, forwarding, framing, hop-by-hop, and control headers', () => {
    const headers: Array<Array<[string, string]>> = [
      [['X-Test', '1'], ['x-test', '2']],
      [['authorization', 'Bearer x']],
      [['cookie', 'sid=x']],
      [['proxy-authorization', 'x']],
      [['forwarded', 'for=1.2.3.4']],
      [['x-forwarded-for', '1.2.3.4']],
      [['content-length', '4']],
      [['transfer-encoding', 'chunked']],
      [['connection', 'keep-alive']],
      [['x-test', 'ok\r\nInjected: yes']],
      [['bad\0name', 'x']],
      [['accept-encoding', 'gzip']],
    ];
    for (const input of headers) {
      assert.throws(
        () => authorizeBrowserRequest({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET', headers: input }),
        BrowserRequestPolicyError,
        JSON.stringify(input),
      );
    }
  });

  it('bounds request bodies and refuses bodies on GET/HEAD', () => {
    assert.throws(
      () => authorizeBrowserRequest({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'GET', body: 'x' }),
      BrowserRequestPolicyError,
    );
    assert.throws(
      () => authorizeBrowserRequest({ url: 'https://example.com/', authorizedDomain: 'example.com', method: 'POST', body: 'x'.repeat(20), limits: { maxRequestBytes: 10 } }),
      (error: unknown) => error instanceof BrowserRequestPolicyError && error.code === 'request_limit_exceeded',
    );
  });
});

describe('browser request DNS policy', () => {
  it('classifies public and reserved IPv4/IPv6 including mapped forms', () => {
    const matrix: Array<[string, boolean]> = [
      ['8.8.8.8', true], ['1.1.1.1', true], ['10.0.0.1', false], ['127.0.0.1', false],
      ['169.254.1.1', false], ['100.64.0.1', false], ['192.0.2.1', false], ['224.0.0.1', false],
      ['2606:4700:4700::1111', true], ['::1', false], ['::', false], ['fc00::1', false],
      ['fe80::1', false], ['2001:db8::1', false], ['::ffff:127.0.0.1', false],
      ['::ffff:8.8.8.8', true], ['2002:7f00:1::', false],
    ];
    for (const [address, expected] of matrix) assert.equal(isPublicIpAddress(address), expected, address);
  });

  it('rejects empty/mixed answers and returns a pinned public address', async () => {
    const request = authorizeBrowserRequest({ url: 'https://api.example.com/', authorizedDomain: 'example.com', method: 'GET' });
    await assert.rejects(resolveSafeDestination(request, async () => []), BrowserRequestPolicyError);
    await assert.rejects(
      resolveSafeDestination(request, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.2', family: 4 },
      ]),
      (error: unknown) => error instanceof BrowserRequestPolicyError && error.code === 'destination_unsafe',
    );
    const pinned = await resolveSafeDestination(request, async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    assert.deepEqual(pinned, { hostname: 'api.example.com', address: '2606:4700:4700::1111', family: 6, port: 443 });
  });
});
