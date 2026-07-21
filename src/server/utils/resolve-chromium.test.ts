import '../test-utils/test-env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import AdmZip from 'adm-zip';
import {
  resolveChromium,
  downloadChromeForTesting,
  ChromiumChecksumMismatchError,
  CHROME_FOR_TESTING_VERSION,
  type ChromiumDeps,
} from './resolve-chromium.js';

/**
 * Chromium ladder contract (U2/R16): system Chrome/Edge > COMATE_CHROMIUM_PATH
 * > pinned lazy download. Download integrity: SHA-256 verified, temp-dir
 * extraction + atomic rename, mismatch fails closed with no half state (KTD-2).
 */

function makeDeps(overrides: Partial<ChromiumDeps>): {
  deps: ChromiumDeps;
  calls: { downloads: number };
} {
  const calls = { downloads: 0 };
  const deps: ChromiumDeps = {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    homeDir: '/home/tester',
    fileExists: () => false,
    findInPath: () => undefined,
    storageDir: mkdtempSync(join(tmpdir(), 'comate-chromium-deps-')),
    download: async () => {
      calls.downloads += 1;
      return '/fake/downloaded/chrome';
    },
    ...overrides,
  };
  return { deps, calls };
}

const CFT_EXE_REL = join(
  'chrome-mac-arm64',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing',
);

describe('resolve-chromium ladder', { concurrency: false }, () => {
  it('returns system Chrome when a well-known install path exists', () => {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const { deps, calls } = makeDeps({
      fileExists: (p) => p === chromePath,
      env: { COMATE_CHROMIUM_PATH: '/configured/chrome' },
    });
    return resolveChromium({ allowDownload: true, deps }).then((hit) => {
      assert.ok(hit);
      assert.strictEqual(hit.source, 'system');
      assert.strictEqual(hit.executablePath, chromePath);
      assert.strictEqual(calls.downloads, 0);
    });
  });

  it('uses COMATE_CHROMIUM_PATH when no system browser exists', async () => {
    const { deps, calls } = makeDeps({
      fileExists: (p) => p === '/configured/chrome',
      env: { COMATE_CHROMIUM_PATH: '/configured/chrome' },
    });
    const hit = await resolveChromium({ allowDownload: true, deps });
    assert.ok(hit);
    assert.strictEqual(hit.source, 'config');
    assert.strictEqual(hit.executablePath, '/configured/chrome');
    assert.strictEqual(calls.downloads, 0);
  });

  it('falls through a stale COMATE_CHROMIUM_PATH to the download rung', async () => {
    const { deps, calls } = makeDeps({
      fileExists: () => false,
      env: { COMATE_CHROMIUM_PATH: '/configured/missing-chrome' },
    });
    const hit = await resolveChromium({ allowDownload: true, deps });
    assert.ok(hit);
    assert.strictEqual(hit.source, 'download');
    assert.strictEqual(calls.downloads, 1);
  });

  it('reuses an existing pinned download without re-downloading', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'comate-chromium-test-'));
    const exe = join(
      storageDir,
      'chromium',
      `cft-${CHROME_FOR_TESTING_VERSION}-mac-arm64`,
      CFT_EXE_REL,
    );
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, 'fake');
    const { deps, calls } = makeDeps({ storageDir, fileExists: (p) => p === exe });
    const hit = await resolveChromium({ allowDownload: false, deps });
    assert.ok(hit);
    assert.strictEqual(hit.source, 'download');
    assert.strictEqual(hit.version, CHROME_FOR_TESTING_VERSION);
    assert.strictEqual(calls.downloads, 0);
  });

  it('does not download when allowDownload is false', async () => {
    const { deps, calls } = makeDeps({});
    const hit = await resolveChromium({ allowDownload: false, deps });
    assert.strictEqual(hit, undefined);
    assert.strictEqual(calls.downloads, 0);
  });

  it('returns undefined on an unsupported platform', async () => {
    const { deps } = makeDeps({ platform: 'linux', arch: 'arm64' });
    const hit = await resolveChromium({ allowDownload: true, deps });
    assert.strictEqual(hit, undefined);
  });

  it('finds Linux browsers via PATH lookup', async () => {
    const { deps } = makeDeps({
      platform: 'linux',
      arch: 'x64',
      findInPath: (cmd) => (cmd === 'google-chrome' ? '/usr/bin/google-chrome' : undefined),
    });
    const hit = await resolveChromium({ allowDownload: false, deps });
    assert.ok(hit);
    assert.strictEqual(hit.source, 'system');
    assert.strictEqual(hit.executablePath, '/usr/bin/google-chrome');
  });
});

describe('downloadChromeForTesting', { concurrency: false }, () => {
  const spec = {
    zipName: 'mac-arm64',
    sha256: '',
    executableRelPath: join('chrome-mac-arm64', 'fake-chrome'),
  };
  let server: Server;
  let port: number;
  let zipBytes: Buffer;
  let storageDir: string;

  before(async () => {
    // Fixture zip holding a fake executable at the expected relative path.
    const zip = new AdmZip();
    zip.addFile(spec.executableRelPath, Buffer.from('#!/bin/fake-chrome\n'));
    zip.addFile('chrome-mac-arm64/helper.txt', Buffer.from('helper'));
    zipBytes = zip.toBuffer();
    spec.sha256 = createHash('sha256').update(zipBytes).digest('hex');

    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(zipBytes);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    storageDir = mkdtempSync(join(tmpdir(), 'comate-cft-download-'));
  });

  after(() => {
    server.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('verifies SHA-256, extracts, and atomically publishes the install', async () => {
    const exe = await downloadChromeForTesting(storageDir, spec, '0.0.0-test', {
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const expectedDir = join(storageDir, 'chromium', 'cft-0.0.0-test-mac-arm64');
    assert.strictEqual(exe, join(expectedDir, spec.executableRelPath));
    assert.ok(existsSync(exe));
    assert.ok(existsSync(join(expectedDir, 'chrome-mac-arm64', 'helper.txt')));
    // No temp artifacts left behind.
    const leftovers = readdirSync(join(storageDir, 'chromium')).filter((n) =>
      n.startsWith('.'),
    );
    assert.deepStrictEqual(leftovers, []);
  });

  it('short-circuits when the pinned install already exists', async () => {
    // The previous test already installed cft-0.0.0-test-mac-arm64; pointing
    // the base URL at a dead server proves no network is touched.
    const exe = await downloadChromeForTesting(storageDir, spec, '0.0.0-test', {
      baseUrl: 'http://127.0.0.1:1',
    });
    assert.ok(existsSync(exe));
  });

  it('fails closed on checksum mismatch: throws and leaves no half state', async () => {
    const badSpec = { ...spec, sha256: '0'.repeat(64) };
    const version = '9.9.9-mismatch';
    await assert.rejects(
      () =>
        downloadChromeForTesting(storageDir, badSpec, version, {
          baseUrl: `http://127.0.0.1:${port}`,
        }),
      (err: unknown) => err instanceof ChromiumChecksumMismatchError,
    );
    const installRoot = join(storageDir, 'chromium');
    const entries = existsSync(installRoot) ? readdirSync(installRoot) : [];
    assert.ok(
      !entries.some((n) => n.includes(version)),
      `no install dir for mismatched version, found: ${entries.join(', ')}`,
    );
    assert.ok(!entries.some((n) => n.startsWith('.download-') || n.startsWith('.staging-')));
  });
});
