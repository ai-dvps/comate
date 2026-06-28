import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_FILE = 'credential.key';

let cachedKey: Buffer | null = null;
let overrideKey: Buffer | null = null;

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
}
