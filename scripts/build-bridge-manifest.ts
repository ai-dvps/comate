#!/usr/bin/env tsx
/**
 * U6 (KTD-3, KTD-9): tauri-format bridge manifest generator + checker.
 *
 * TAURI-EXEMPTION: this file is the sanctioned exception to the "no tauri
 * references" cleanup rule — it exists precisely to keep serving the LAST
 * Tauri install base (0.0.33) until it drains to zero (KTD-3).
 *
 * The last Tauri clients poll
 *   https://github.com/ai-dvps/comate/releases/latest/download/latest.json
 * and expect the static tauri-plugin-updater manifest format. The bridge
 * release (first Electron release) and every release after it must carry a
 * `latest.json` whose URLs point at the ELECTRON installers:
 *
 *   darwin-aarch64  → Comate-<ver>-mac-arm64.app.tar.gz  (repacked .app)
 *   darwin-x86_64   → Comate-<ver>-mac-x64.app.tar.gz
 *   windows-x86_64  → Comate-<ver>-win-x64.exe           (NSIS, raw exe)
 *
 * Schema ground truth (do not guess — these are the contract):
 *  - the live 0.0.33 manifest (scripts/fixtures/tauri-latest-0.0.33.json,
 *    fetched from the published v0.0.33 release);
 *  - tauri-plugin-updater v2 source (plugins-workspace@v2,
 *    plugins/updater/src/updater.rs): RemoteRelease deserializer wants
 *    {version, notes?, pub_date?, platforms{<target>:{url, signature}}};
 *    target lookup tries `{os}-{arch}-{installer}` first and falls back to
 *    `{os}-{arch}` (get_urls), so the three plain keys suffice;
 *  - Windows payload: updater.rs `extract` accepts a RAW .exe
 *    (infer::app::is_exe → treated as NSIS) — no .nsis.zip needed;
 *  - macOS payload: install_inner extracts the tar.gz stripping the first
 *    path component, so the archive must contain `Comate.app/Contents/...`
 *    at its root (produced by `tar -czf <out> -C <dir> Comate.app`);
 *  - signature: `verify_signature` base64-decodes the manifest value into
 *    the minisign signature-box TEXT (4 lines: untrusted comment / base64
 *    sig / trusted comment / base64 global sig). That base64 string is
 *    EXACTLY the content of the `.sig` file produced by
 *    `tauri signer sign` (verified against the 0.0.33 release assets).
 *
 * Signing order (KTD-9): Authenticode / notarize FIRST (electron-builder),
 * tauri signer (minisign) LAST, over the final artifact bytes. The `check`
 * command verifies each signature against the actual asset bytes — signing
 * before Authenticode (order inversion) makes this check fail.
 *
 * Usage:
 *   # Generate (CI bridge-manifest job, or local dry-run):
 *   tsx scripts/build-bridge-manifest.ts generate \
 *     --version 0.1.0 \
 *     --release-base-url https://github.com/ai-dvps/comate/releases/download/v0.1.0 \
 *     --asset darwin-aarch64=Comate-0.1.0-mac-arm64.app.tar.gz=@sigs/Comate-0.1.0-mac-arm64.app.tar.gz.sig \
 *     --asset darwin-x86_64=Comate-0.1.0-mac-x64.app.tar.gz=@sigs/Comate-0.1.0-mac-x64.app.tar.gz.sig \
 *     --asset windows-x86_64=Comate-0.1.0-win-x64.exe=@sigs/Comate-0.1.0-win-x64.exe.sig \
 *     --out latest.json
 *
 *   # Check an existing manifest (schema + version floor; with --assets-dir
 *   # also cryptographically verifies every platform signature):
 *   tsx scripts/build-bridge-manifest.ts check latest.json --assets-dir ./bridge-assets
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Bridge contract constants
// ---------------------------------------------------------------------------

/** Last Tauri release; bridge manifests must be strictly newer (updater.rs: `release.version > self.current_version`). */
export const LAST_TAURI_VERSION = '0.0.33';

/** Platform keys the bridge manifest must carry (plan U6 / KTD-3). */
export const REQUIRED_PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'] as const;

/**
 * Updater public key of the old-line clients, from the last committed
 * src-tauri/tauri.conf.json (git show 3e19ebb8:src-tauri/tauri.conf.json,
 * plugins.updater.pubkey). Old clients verify against this key; it is public
 * by design. Overridable via --pubkey for tests.
 */
export const DEFAULT_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk5QUU3MTM0MEQ5MDM1NzYKUldSMk5aQU5OSEd1bVZlNGZuaGx1c0NKZHB4SG9EWTlzaTlLeXdndm13bEZ5QXhHclpZYUhSQ2wK';

/** GitHub repo owning the releases (tauri.conf.json updater endpoint). */
const DEFAULT_REPO = 'ai-dvps/comate';

/** Matches the releaseBody tauri-action used for the old line. */
const DEFAULT_NOTES = 'See the assets to download and install this version.';

// tauri target key: {os}-{arch} with optional bundle-type suffix
// (updater.rs target()/get_urls — e.g. darwin-aarch64, windows-x86_64-msi).
const PLATFORM_KEY_RE = /^(darwin|windows|linux)-(x86_64|aarch64|i686|armv7|riscv64)(-[a-z0-9]+)?$/;
const ASSET_NAME_RE = /^[\w.+-]+$/;

export interface BridgeAsset {
  platform: string;
  /** Artifact file name on the GitHub release (e.g. Comate-0.1.0-win-x64.exe). */
  file: string;
  /** base64 of the minisign signature box — the content of the `.sig` file. */
  signature: string;
}

export interface BridgeManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { signature: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Minimal semver (dependency-free; release versions are simple triples)
// ---------------------------------------------------------------------------

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(input: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Returns >0 when a > b, <0 when a < b, 0 when equal. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // A release outranks any of its prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const [x, y] = [a.prerelease[i], b.prerelease[i]];
    const [xn, yn] = [Number(x), Number(y)];
    const xIsNum = /^\d+$/.test(x);
    const yIsNum = /^\d+$/.test(y);
    if (xIsNum && yIsNum) {
      if (xn !== yn) return xn - yn;
    } else if (xIsNum !== yIsNum) {
      return xIsNum ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.prerelease.length - b.prerelease.length;
}

// ---------------------------------------------------------------------------
// minisign signature-box parsing + ed25519 verification
// (mirrors tauri-plugin-updater verify_signature + minisign-verify decoding)
// ---------------------------------------------------------------------------

interface ParsedSignatureBox {
  algorithm: string; // 'Ed' (pure ed25519) or 'ED' (legacy prehashed)
  keynum: Buffer;
  signature: Buffer;
}

/** Structural parse of the manifest signature value (base64 of the 4-line box). */
export function parseSignatureBox(signatureB64: string): ParsedSignatureBox {
  let text: string;
  try {
    text = Buffer.from(signatureB64.trim(), 'base64').toString('utf8');
  } catch {
    throw new Error('signature is not valid base64');
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 4) {
    throw new Error('signature box must have 4 lines (untrusted comment, signature, trusted comment, global signature)');
  }
  if (!lines[0].startsWith('untrusted comment:')) {
    throw new Error('signature box line 1 must be an untrusted comment');
  }
  if (!lines[2].startsWith('trusted comment:')) {
    throw new Error('signature box line 3 must be a trusted comment');
  }
  const raw = Buffer.from(lines[1], 'base64');
  if (raw.length !== 74) {
    throw new Error(`signature line must decode to 74 bytes (alg+keynum+sig), got ${raw.length}`);
  }
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`unsupported signature algorithm bytes: ${JSON.stringify(algorithm)}`);
  }
  const global = Buffer.from(lines[3], 'base64');
  if (global.length !== 64) {
    throw new Error(`global signature line must decode to 64 bytes, got ${global.length}`);
  }
  return { algorithm, keynum: raw.subarray(2, 10), signature: raw.subarray(10) };
}

interface ParsedPublicKey {
  keynum: Buffer;
  publicKey: Buffer;
}

/** Parse the tauri.conf.json `pubkey` value (base64 of the 2-line pubkey text). */
export function parsePublicKey(pubkeyB64: string): ParsedPublicKey {
  const text = Buffer.from(pubkeyB64.trim(), 'base64').toString('utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error('public key must be base64 of the 2-line minisign pubkey text');
  }
  const raw = Buffer.from(lines[1], 'base64');
  if (raw.length !== 42) {
    throw new Error(`public key line must decode to 42 bytes (alg+keynum+key), got ${raw.length}`);
  }
  if (raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('public key is not an ed25519 minisign key');
  }
  return { keynum: raw.subarray(2, 10), publicKey: raw.subarray(10) };
}

/** DER SPKI prefix for a raw ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Cryptographically verify a platform signature against the asset bytes —
 * the same check old-line clients run (updater.rs verify_signature). Returns
 * true/false; throws only on malformed inputs. A signature made BEFORE
 * Authenticode/notarization rewrote the artifact fails here (KTD-9 order).
 */
export function verifyAssetSignature(asset: Buffer, signatureB64: string, pubkeyB64: string): boolean {
  const box = parseSignatureBox(signatureB64);
  const key = parsePublicKey(pubkeyB64);
  if (!box.keynum.equals(key.keynum)) return false;
  const message =
    box.algorithm === 'ED' ? crypto.createHash('blake2b512').update(asset).digest() : asset;
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key.publicKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, message, publicKey, box.signature);
}

// ---------------------------------------------------------------------------
// Manifest build + validation
// ---------------------------------------------------------------------------

export function buildManifest(options: {
  version: string;
  releaseBaseUrl: string;
  assets: BridgeAsset[];
  notes?: string;
  pubDate?: string;
}): BridgeManifest {
  const version = options.version.trim().replace(/^v/, '');
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`invalid semver version: ${options.version}`);
  const floor = parseSemver(LAST_TAURI_VERSION)!;
  if (compareSemver(parsed, floor) <= 0) {
    throw new Error(
      `bridge manifest version ${version} must be > ${LAST_TAURI_VERSION} (last Tauri release) or old clients will not update`,
    );
  }

  const base = options.releaseBaseUrl.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    throw new Error(`release base URL must be https: ${options.releaseBaseUrl}`);
  }

  const pubDate = options.pubDate ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(pubDate))) {
    throw new Error(`pub_date is not RFC3339-parseable: ${pubDate}`);
  }

  const platforms: BridgeManifest['platforms'] = {};
  for (const asset of options.assets) {
    if (!PLATFORM_KEY_RE.test(asset.platform)) {
      throw new Error(`invalid tauri platform key: ${asset.platform}`);
    }
    if (!ASSET_NAME_RE.test(asset.file)) {
      throw new Error(`invalid asset file name: ${asset.file}`);
    }
    if (platforms[asset.platform]) {
      throw new Error(`duplicate platform key: ${asset.platform}`);
    }
    // Structural validation of the inline signature (updater.rs expects the
    // base64-of-signature-box format; anything else fails on old clients).
    parseSignatureBox(asset.signature);
    platforms[asset.platform] = {
      signature: asset.signature.trim(),
      url: `${base}/${asset.file}`,
    };
  }

  const manifest: BridgeManifest = {
    version,
    notes: options.notes ?? DEFAULT_NOTES,
    pub_date: pubDate,
    platforms,
  };
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`generated manifest failed self-check:\n - ${problems.join('\n - ')}`);
  }
  return manifest;
}

/**
 * Schema + contract validation for an existing manifest. Returns a list of
 * problems (empty = valid). Mirrors the tauri-plugin-updater RemoteRelease
 * deserializer plus the bridge-specific floor/required-platform rules.
 */
export function validateManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return ['manifest is not a JSON object'];
  }
  const m = manifest as Record<string, unknown>;

  const version = typeof m.version === 'string' ? parseSemver(m.version) : null;
  if (!version) {
    problems.push(`version missing or not semver: ${JSON.stringify(m.version)}`);
  } else if (compareSemver(version, parseSemver(LAST_TAURI_VERSION)!) <= 0) {
    problems.push(`version must be > ${LAST_TAURI_VERSION} (last Tauri release)`);
  }

  if (m.notes !== undefined && typeof m.notes !== 'string') {
    problems.push('notes must be a string when present');
  }
  if (m.pub_date !== undefined) {
    if (typeof m.pub_date !== 'string' || Number.isNaN(Date.parse(m.pub_date))) {
      problems.push(`pub_date missing or not RFC3339-parseable: ${JSON.stringify(m.pub_date)}`);
    }
  }

  if (typeof m.platforms !== 'object' || m.platforms === null || Array.isArray(m.platforms)) {
    problems.push('platforms missing or not an object');
    return problems;
  }
  const platforms = m.platforms as Record<string, unknown>;
  for (const required of REQUIRED_PLATFORMS) {
    if (!(required in platforms)) {
      problems.push(`missing required platform key: ${required}`);
    }
  }
  for (const [key, value] of Object.entries(platforms)) {
    if (!PLATFORM_KEY_RE.test(key)) {
      problems.push(`invalid platform key: ${key}`);
    }
    if (typeof value !== 'object' || value === null) {
      problems.push(`platform ${key}: entry is not an object`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.url !== 'string' || !/^https:\/\//.test(entry.url)) {
      problems.push(`platform ${key}: url missing or not https`);
    }
    if (typeof entry.signature !== 'string' || entry.signature.length === 0) {
      problems.push(`platform ${key}: signature missing`);
    } else {
      try {
        parseSignatureBox(entry.signature);
      } catch (err) {
        problems.push(`platform ${key}: signature malformed — ${(err as Error).message}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  tsx scripts/build-bridge-manifest.ts generate --version <semver> \
    (--release-base-url <url> | --tag <vX.Y.Z>) \
    --asset <platform>=<release-file>=<signature-base64|@sig-file> [--asset ...] \
    [--notes <text>] [--pub-date <rfc3339>] [--out <path>]
  tsx scripts/build-bridge-manifest.ts check <latest.json> [--assets-dir <dir>] [--pubkey <base64>]

Defaults: --tag derives https://github.com/${DEFAULT_REPO}/releases/download/<tag>;
--out defaults to stdout; check verifies signatures cryptographically when
--assets-dir is given (asset file = basename of the platform URL).`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseFlags(args: string[]): { flags: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), [...(flags.get(arg.slice(2, eq)) ?? []), arg.slice(eq + 1)]);
      } else {
        const value = args[++i];
        if (value === undefined) fail(`flag ${arg} requires a value`);
        flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function oneFlag(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (!values || values.length === 0) return undefined;
  if (values.length > 1) fail(`--${name} given more than once`);
  return values[0];
}

function readSignature(value: string): string {
  if (value.startsWith('@')) {
    return fs.readFileSync(value.slice(1), 'utf8').trim();
  }
  return value;
}

function runGenerate(args: string[]): void {
  const { flags } = parseFlags(args);
  const version = oneFlag(flags, 'version') ?? fail('--version is required');
  const tag = oneFlag(flags, 'tag');
  const baseUrl =
    oneFlag(flags, 'release-base-url') ??
    (tag ? `https://github.com/${DEFAULT_REPO}/releases/download/${tag}` : undefined) ??
    fail('--release-base-url or --tag is required');
  const assetSpecs = flags.get('asset') ?? [];
  if (assetSpecs.length === 0) fail('at least one --asset is required');
  const assets: BridgeAsset[] = assetSpecs.map((spec) => {
    const [platform, file, sig] = spec.split('=');
    if (!platform || !file || !sig) {
      fail(`--asset must be <platform>=<file>=<signature|@file>, got: ${spec}`);
    }
    return { platform, file, signature: readSignature(sig) };
  });

  const manifest = buildManifest({
    version,
    releaseBaseUrl: baseUrl,
    assets,
    notes: oneFlag(flags, 'notes'),
    pubDate: oneFlag(flags, 'pub-date'),
  });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const out = oneFlag(flags, 'out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    console.log(`wrote ${out} (version ${manifest.version}, platforms: ${Object.keys(manifest.platforms).join(', ')})`);
  } else {
    process.stdout.write(json);
  }
}

function runCheck(args: string[]): void {
  const { flags, positional } = parseFlags(args);
  const file = positional[0] ?? fail('check requires a latest.json path');
  const pubkey = oneFlag(flags, 'pubkey') ?? DEFAULT_PUBKEY;
  parsePublicKey(pubkey); // fail fast on a malformed key

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse ${file}: ${(err as Error).message}`);
  }

  const problems = validateManifest(manifest);
  const assetsDir = oneFlag(flags, 'assets-dir');
  if (problems.length === 0 && assetsDir) {
    const { platforms } = manifest as BridgeManifest;
    for (const [platform, entry] of Object.entries(platforms)) {
      const assetPath = path.join(assetsDir, path.basename(entry.url));
      if (!fs.existsSync(assetPath)) {
        problems.push(`platform ${platform}: asset not found: ${assetPath}`);
        continue;
      }
      let ok = false;
      try {
        ok = verifyAssetSignature(fs.readFileSync(assetPath), entry.signature, pubkey);
      } catch (err) {
        problems.push(`platform ${platform}: signature verification error — ${(err as Error).message}`);
        continue;
      }
      if (!ok) {
        problems.push(
          `platform ${platform}: signature does NOT match ${path.basename(assetPath)} ` +
            '(signed bytes differ from the released artifact — minisign must run AFTER Authenticode/notarize, KTD-9)',
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(`latest.json check FAILED:`);
    for (const p of problems) console.error(` - ${p}`);
    process.exit(1);
  }
  console.log(
    `latest.json OK: version ${(manifest as BridgeManifest).version}, ` +
      `${Object.keys((manifest as BridgeManifest).platforms).length} platforms` +
      (assetsDir ? ', all signatures verified against assets' : ' (schema only, no --assets-dir)'),
  );
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'generate') runGenerate(rest);
  else if (command === 'check') runCheck(rest);
  else {
    console.error(USAGE);
    process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 2);
  }
}

// Run only when executed directly (importable for tests).
const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
const thisFile = fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedAs === thisFile) {
  main();
}
