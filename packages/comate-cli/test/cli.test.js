import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sharedContractFixtures } from '@comate/api-contracts';
import { postJson } from '../dist/lib/http.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tempDirs = [];
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function run(args, { input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        PATH: process.env.PATH,
        COMATE_SESSION_TOKEN: 'task-token-fixture',
        http_proxy: '', HTTP_PROXY: '', https_proxy: '', HTTPS_PROXY: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('comate api request', () => {
  it('uses the shared fixture for --stdin --json and prints exact BrokerResult JSON', async () => {
    let received;
    const base = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        assert.equal(req.url, '/api/broker/request');
        assert.equal(req.headers.authorization, 'Bearer task-token-fixture');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(sharedContractFixtures.brokerSuccess));
      });
    });
    const result = await run(['api', 'request', '--stdin', '--json'], {
      input: JSON.stringify(sharedContractFixtures.brokerRequest),
      env: { COMATE_SERVER_URL: base },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), sharedContractFixtures.brokerSuccess);
    assert.deepEqual(received, sharedContractFixtures.brokerRequest);
  });

  it('reads --recipe files and emits readable credential-free human output', async () => {
    const base = await listen((_req, res) => res.end(JSON.stringify(sharedContractFixtures.brokerSuccess)));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'comate-cli-'));
    tempDirs.push(dir);
    const recipe = path.join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify(sharedContractFixtures.brokerRequest));
    const result = await run(['api', 'request', '--recipe', recipe], { env: { COMATE_SERVER_URL: base } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^HTTP 200/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /task-token-fixture/i);
  });

  it('prints human BrokerResult failures to stderr and exits nonzero', async () => {
    const failure = {
      version: 1, ok: false, code: 'authorization_denied',
      message: 'The request was not authorized.', recovery: 'Approve a new request.', retryable: false,
    };
    const base = await listen((_req, res) => res.end(JSON.stringify(failure)));
    const result = await run(['api', 'request', '--stdin'], {
      input: JSON.stringify(sharedContractFixtures.brokerRequest),
      env: { COMATE_SERVER_URL: base },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /authorization_denied.*not authorized/s);
    assert.doesNotMatch(result.stderr, /task-token-fixture/);

    const machine = await run(['api', 'request', '--stdin', '--json'], {
      input: JSON.stringify(sharedContractFixtures.brokerRequest),
      env: { COMATE_SERVER_URL: base },
    });
    assert.equal(machine.code, 1);
    assert.deepEqual(JSON.parse(machine.stdout), failure);
    assert.equal(machine.stderr, '');
  });

  it('rejects version mismatch and missing task context without network fallback', async () => {
    const invalid = { ...sharedContractFixtures.brokerRequest, version: 999 };
    const malformed = await run(['api', 'request', '--stdin', '--json'], {
      input: JSON.stringify(invalid), env: { COMATE_SERVER_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /contract/);
    const missing = await run(['api', 'request', '--stdin'], {
      input: JSON.stringify(sharedContractFixtures.brokerRequest),
      env: { COMATE_SESSION_TOKEN: '', COMATE_SERVER_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /live Comate task/);
  });

  it('uses HTTP_PROXY despite NO_PROXY for loopback requests', async () => {
    let absoluteUrl;
    const proxy = await listen((req, res) => {
      absoluteUrl = req.url;
      res.end(JSON.stringify(sharedContractFixtures.brokerSuccess));
    });
    const result = await run(['api', 'request', '--stdin', '--json'], {
      input: JSON.stringify(sharedContractFixtures.brokerRequest),
      env: {
        COMATE_SERVER_URL: 'http://127.0.0.1:1',
        HTTP_PROXY: proxy,
        NO_PROXY: '127.0.0.1,localhost',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(absoluteUrl, 'http://127.0.0.1:1/api/broker/request');
  });

  it('bounds transport waits with an aborting timeout', async () => {
    const base = await listen(() => {});
    await assert.rejects(
      postJson(`${base}/api/broker/request`, {}, 'token', { timeoutMs: 20 }),
      /Timed out/,
    );
  });
});
