import { randomBytes, createCipheriv, createDecipheriv, createHmac, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../storage/data-dir.js';
import { diagLog } from './diag-logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_FILE = 'credential.key';

let cachedKey: Buffer | null = null;
let overrideKey: Buffer | null = null;
let browserBindingVersions = { current: 1, prior: null as number | null };

function getKeyFilePath(): string {
  return join(getStorageDir(), KEY_FILE);
}

function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function getCredentialKey(): Buffer {
  if (overrideKey) {
    return overrideKey;
  }
  if (cachedKey) {
    return cachedKey;
  }

  const keyPath = getKeyFilePath();
  if (existsSync(keyPath)) {
    cachedKey = Buffer.from(readFileSync(keyPath, 'utf-8'), 'base64');
    if (cachedKey.length !== KEY_LENGTH) {
      throw new Error('Credential encryption key has unexpected length');
    }
    return cachedKey;
  }

  const dir = getStorageDir();
  mkdirSync(dir, { recursive: true });
  const key = generateKey();
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  cachedKey = key;
  return key;
}

/** Override the encryption key (used only by tests). */
export function __setCredentialKey(key: Buffer | null): void {
  overrideKey = key;
  cachedKey = key;
}

/** Derive a deterministic key from a passphrase for test or migration use. */
export function deriveKeyFromPassphrase(passphrase: string): Buffer {
  return scryptSync(passphrase, 'comate-credential-salt', KEY_LENGTH);
}

export interface BrowserBinding {
  version: number;
  digest: string;
}

function canonicalBindingValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${JSON.stringify(value.normalize('NFC'))}`;
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Browser binding values must contain finite numbers');
    return `n:${Object.is(value, -0) ? '0' : String(value)}`;
  }
  if (Array.isArray(value)) return `a:[${value.map(canonicalBindingValue).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('Browser binding values must be plain objects');
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => {
        if (child === undefined) throw new Error('Browser binding values must not contain undefined');
        return `${canonicalBindingValue(key)}=${canonicalBindingValue(child)}`;
      });
    return `o:{${entries.join(',')}}`;
  }
  throw new Error(`Unsupported browser binding value type: ${typeof value}`);
}

function browserBindingDigest(purpose: string, value: unknown, version: number): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(purpose)) throw new Error('Invalid browser binding purpose');
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error('Invalid browser binding key version');
  const derived = createHmac('sha256', getCredentialKey())
    .update(`comate/browser-binding/key/v${version}\0${purpose}`, 'utf8')
    .digest();
  return createHmac('sha256', derived)
    .update(`comate/browser-binding/value/v1\0${canonicalBindingValue(value)}`, 'utf8')
    .digest('base64url');
}

export function createBrowserBinding(
  purpose: string,
  value: unknown,
  version = browserBindingVersions.current,
): BrowserBinding {
  if (version !== browserBindingVersions.current && version !== browserBindingVersions.prior) {
    throw new Error('Browser binding key version is not active');
  }
  return { version, digest: browserBindingDigest(purpose, value, version) };
}

export function verifyBrowserBinding(purpose: string, value: unknown, binding: BrowserBinding): boolean {
  if (binding.version !== browserBindingVersions.current && binding.version !== browserBindingVersions.prior) return false;
  if (typeof binding.digest !== 'string' || binding.digest.length > 128) return false;
  try {
    const expected = Buffer.from(browserBindingDigest(purpose, value, binding.version));
    const actual = Buffer.from(binding.digest);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Test/migration seam. It changes only derived browser-binding versions. */
export function __setBrowserBindingKeyVersions(versions: { current: number; prior: number | null } | null): void {
  browserBindingVersions = versions ?? { current: 1, prior: null };
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded string containing the
 * IV, authentication tag, and ciphertext. Never logs or exposes the plaintext.
 */
export function encryptCredential(plaintext: string): string {
  const key = getCredentialKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt a value produced by `encryptCredential`. Throws if the ciphertext has
 * been tampered with or the key is incorrect.
 */
export function decryptCredential(ciphertext: string): string {
  try {
    const key = getCredentialKey();
    const combined = Buffer.from(ciphertext, 'base64');
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Credential ciphertext is too short');
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
  } catch (err) {
    diagLog('Credential decryption failed', {
      error: err instanceof Error ? err.message : String(err),
      ciphertextLength: ciphertext.length,
    });
    throw new Error('Failed to decrypt credential');
  }
}
