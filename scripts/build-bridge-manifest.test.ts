/**
 * U6 unit tests for scripts/build-bridge-manifest.ts.
 *
 * Real signature vectors below were produced with the actual old-line
 * toolchain: `@tauri-apps/cli@2 signer generate` + `signer sign` on the
 * payload "hello bridge artifact v1" (password-protected key). They anchor
 * byte-level compatibility with what tauri-plugin-updater verifies — the
 * same format as the published 0.0.33 manifest
 * (scripts/fixtures/tauri-latest-0.0.33.json, the live contract).
 *
 * Run: tsx --test scripts/build-bridge-manifest.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  compareSemver,
  parsePublicKey,
  parseSemver,
  parseSignatureBox,
  REQUIRED_PLATFORMS,
  validateManifest,
  verifyAssetSignature,
} from './build-bridge-manifest.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

// --- Real vectors from `@tauri-apps/cli@2 signer sign` (see header) --------
const VECTOR_PAYLOAD = Buffer.from('hello bridge artifact v1');
const VECTOR_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE0ODI0NzNEREIwOTMwRDkKUldUWk1BbmJQVWVDcEhkeWcyOHRsaUZJRVYxSXBBNUhXb1lrUFNSZ081anprWDBpaStJbGRremMK';
const VECTOR_SIGNATURE =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWk1BbmJQVWVDcEY3ZEwyTlFtZ2ViMHd4OW5QQTlCU3ROcmg3SmtOVGJBYktEK0xtZXRYYjhMalJFMDFXQ2Z0eHV2K3RJaW15cDVYSHpJOGZLTG15eDZjNnZwbUxwcEFzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg2MTI5NTQ4CWZpbGU6YXJ0aWZhY3QuYmluClduZE5FV1FRYzR1UW40Q05TWHV0SzJXbEdjcWkrZGNCVmJ3Z29FRHJIYnh2eG5lcWljSWoya3NnNjNKTkhBcGVtR0U2QUpheTR5S2xad1BIOUhzNkFBPT0K';

const BASE_URL = 'https://github.com/ai-dvps/comate/releases/download/v0.1.0';

function validAssets() {
  return [
    { platform: 'darwin-aarch64', file: 'Comate-0.1.0-mac-arm64.app.tar.gz', signature: VECTOR_SIGNATURE },
    { platform: 'darwin-x86_64', file: 'Comate-0.1.0-mac-x64.app.tar.gz', signature: VECTOR_SIGNATURE },
    { platform: 'windows-x86_64', file: 'Comate-0.1.0-win-x64.exe', signature: VECTOR_SIGNATURE },
  ];
}

// --- semver ----------------------------------------------------------------

test('parseSemver accepts plain and v-prefixed triples, rejects garbage', () => {
  assert.deepEqual(parseSemver('0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: [] });
  assert.deepEqual(parseSemver('v1.2.3')?.major, 1);
  assert.equal(parseSemver('0.0.33-beta.1')?.prerelease.join('.'), 'beta.1');
  assert.equal(parseSemver('0.0'), null);
  assert.equal(parseSemver('latest'), null);
});

test('compareSemver orders numerically, release outranks prerelease', () => {
  assert.ok(compareSemver(parseSemver('0.1.0')!, parseSemver('0.0.33')!) > 0);
  assert.ok(compareSemver(parseSemver('0.0.34')!, parseSemver('0.0.33')!) > 0);
  assert.ok(compareSemver(parseSemver('0.0.33')!, parseSemver('0.0.33')!) === 0);
  assert.ok(compareSemver(parseSemver('1.0.0-rc.1')!, parseSemver('1.0.0')!) < 0);
  assert.ok(compareSemver(parseSemver('0.9.9')!, parseSemver('0.10.0')!) < 0);
});

// --- minisign format + crypto ----------------------------------------------

test('parseSignatureBox parses a real tauri signer box', () => {
  const box = parseSignatureBox(VECTOR_SIGNATURE);
  // tauri signer emits the legacy prehashed format ('ED' = blake2b512 + ed25519).
  assert.equal(box.algorithm, 'ED');
  assert.equal(box.signature.length, 64);
  assert.equal(box.keynum.length, 8);
});

test('parseSignatureBox rejects malformed values', () => {
  assert.throws(() => parseSignatureBox('not base64 box!!!'));
  assert.throws(() => parseSignatureBox(Buffer.from('{"json":true}').toString('base64')));
});

test('parsePublicKey parses the tauri.conf.json pubkey format', () => {
  const key = parsePublicKey(VECTOR_PUBKEY);
  assert.equal(key.publicKey.length, 32);
  // Keynum is stored little-endian; the comment displays it big-endian.
  assert.equal(
    Buffer.from(key.keynum).reverse().toString('hex').toUpperCase(),
    'A482473DDB0930D9',
  );
});

test('verifyAssetSignature verifies a real tauri-produced signature', () => {
  assert.equal(verifyAssetSignature(VECTOR_PAYLOAD, VECTOR_SIGNATURE, VECTOR_PUBKEY), true);
});

test('order inversion: artifact modified after minisign → verification fails', () => {
  // Simulates KTD-9 violation: minisign ran first, Authenticode/notarize
  // rewrote the artifact afterwards. The check step must catch this.
  const rewritten = Buffer.concat([VECTOR_PAYLOAD, Buffer.from(' [Authenticode modified me]')]);
  assert.equal(verifyAssetSignature(rewritten, VECTOR_SIGNATURE, VECTOR_PUBKEY), false);
});

test('wrong key / tampered signature → verification fails', () => {
  // Tamper the signature itself (same keynum, corrupted sig bytes).
  const box = parseSignatureBox(VECTOR_SIGNATURE);
  box.signature[0] ^= 0xff;
  const lines = Buffer.from(VECTOR_SIGNATURE, 'base64').toString('utf8').split('\n');
  lines[1] = Buffer.concat([Buffer.from('Ed'), box.keynum, box.signature]).toString('base64');
  const tampered = Buffer.from(lines.join('\n')).toString('base64');
  assert.equal(verifyAssetSignature(VECTOR_PAYLOAD, tampered, VECTOR_PUBKEY), false);
  // A signature made with a DIFFERENT key must not verify against ours.
  const other = crypto.generateKeyPairSync('ed25519');
  const otherSig = crypto.sign(null, VECTOR_PAYLOAD, other.privateKey);
  const otherBoxLines = [
    'untrusted comment: test',
    Buffer.concat([Buffer.from('Ed'), parsePublicKey(VECTOR_PUBKEY).keynum, otherSig]).toString('base64'),
    'trusted comment: test',
    Buffer.alloc(64).toString('base64'),
  ];
  const otherBox = Buffer.from(otherBoxLines.join('\n')).toString('base64');
  assert.equal(verifyAssetSignature(VECTOR_PAYLOAD, otherBox, VECTOR_PUBKEY), false);
});

// --- buildManifest ----------------------------------------------------------

test('generate: produces the tauri-plugin-updater schema (happy path)', () => {
  const manifest = buildManifest({
    version: 'v0.1.0', // v-prefix normalized away, matching the 0.0.33 format
    releaseBaseUrl: BASE_URL,
    assets: validAssets(),
    pubDate: '2026-08-07T12:00:00.000Z',
  });
  assert.equal(manifest.version, '0.1.0');
  assert.equal(typeof manifest.notes, 'string');
  assert.equal(manifest.pub_date, '2026-08-07T12:00:00.000Z');
  assert.deepEqual(Object.keys(manifest.platforms), [...REQUIRED_PLATFORMS]);
  const mac = manifest.platforms['darwin-aarch64'];
  assert.equal(mac.signature, VECTOR_SIGNATURE);
  assert.equal(mac.url, `${BASE_URL}/Comate-0.1.0-mac-arm64.app.tar.gz`);
  // Self-check embedded in buildManifest: no problems.
  assert.deepEqual(validateManifest(manifest), []);
});

test('generate: version floor — must be > 0.0.33 (semver bump)', () => {
  for (const bad of ['0.0.33', '0.0.10', 'v0.0.33']) {
    assert.throws(
      () => buildManifest({ version: bad, releaseBaseUrl: BASE_URL, assets: validAssets() }),
      /> 0\.0\.33/,
    );
  }
  assert.doesNotThrow(() =>
    buildManifest({ version: '0.0.34', releaseBaseUrl: BASE_URL, assets: validAssets() }),
  );
});

test('generate: rejects unknown platforms, bad asset names, malformed signatures', () => {
  assert.throws(() =>
    buildManifest({
      version: '0.1.0',
      releaseBaseUrl: BASE_URL,
      assets: [{ platform: 'plan9-x86_64', file: 'a.exe', signature: VECTOR_SIGNATURE }],
    }),
  );
  assert.throws(() =>
    buildManifest({
      version: '0.1.0',
      releaseBaseUrl: BASE_URL,
      assets: [{ platform: 'windows-x86_64', file: 'has space.exe', signature: VECTOR_SIGNATURE }],
    }),
  );
  assert.throws(() =>
    buildManifest({
      version: '0.1.0',
      releaseBaseUrl: BASE_URL,
      assets: [{ platform: 'windows-x86_64', file: 'a.exe', signature: 'AAAA' }],
    }),
  );
});

// --- validateManifest against the live 0.0.33 contract ----------------------

test('fixture: real 0.0.33 manifest matches our schema (fails only the version floor)', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'tauri-latest-0.0.33.json'), 'utf8'),
  );
  const problems = validateManifest(fixture);
  // The old manifest is schema-valid (all sig boxes parse, URLs https,
  // bundle-suffixed alias keys accepted) — the ONLY violation is the bridge
  // version floor, which is exactly what should flag the old line.
  assert.deepEqual(problems, ['version must be > 0.0.33 (last Tauri release)']);
});

test('validateManifest flags missing platforms and non-https urls', () => {
  const manifest = buildManifest({
    version: '0.1.0',
    releaseBaseUrl: BASE_URL,
    assets: validAssets(),
  }) as unknown as Record<string, unknown>;
  const platforms = manifest.platforms as Record<string, unknown>;
  delete platforms['windows-x86_64'];
  platforms['darwin-aarch64'] = { signature: VECTOR_SIGNATURE, url: 'http://insecure.example/x' };
  const problems = validateManifest(manifest);
  assert.ok(problems.some((p) => p.includes('windows-x86_64')));
  assert.ok(problems.some((p) => p.includes('not https')));
});

// --- CLI round trip (generate → check with cryptographic verification) ------

test('CLI: generate then check --assets-dir verifies signatures end-to-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-manifest-'));
  const script = path.join(__dirname, 'build-bridge-manifest.ts');
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir);
  // The "released" bytes for each platform (here: the signed payload).
  const files = {
    'darwin-aarch64': 'Comate-0.1.0-mac-arm64.app.tar.gz',
    'darwin-x86_64': 'Comate-0.1.0-mac-x64.app.tar.gz',
    'windows-x86_64': 'Comate-0.1.0-win-x64.exe',
  };
  const assetArgs: string[] = [];
  for (const [platform, file] of Object.entries(files)) {
    fs.writeFileSync(path.join(assetsDir, file), VECTOR_PAYLOAD);
    assetArgs.push('--asset', `${platform}=${file}=${VECTOR_SIGNATURE}`);
  }
  const out = path.join(dir, 'latest.json');
  execFileSync(
    TSX,
    [script, 'generate', '--version', '0.1.0', '--release-base-url', BASE_URL, ...assetArgs, '--out', out],
    { stdio: 'pipe' },
  );
  const check = execFileSync(
    TSX,
    [script, 'check', out, '--assets-dir', assetsDir, '--pubkey', VECTOR_PUBKEY],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  assert.match(check, /all signatures verified/);

  // Order-inversion at the CLI level: rewrite one asset AFTER signing → the
  // check step must exit non-zero and name the platform.
  fs.writeFileSync(path.join(assetsDir, files['windows-x86_64']), Buffer.concat([VECTOR_PAYLOAD, Buffer.from('x')]));
  assert.throws(
    () =>
      execFileSync(
        TSX,
        [script, 'check', out, '--assets-dir', assetsDir, '--pubkey', VECTOR_PUBKEY],
        { stdio: 'pipe' },
      ),
    (err: { status?: number; stderr?: string }) =>
      err.status === 1 && String(err.stderr).includes('windows-x86_64'),
  );
});
