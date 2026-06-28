import '../test-utils/test-env.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  decryptCredential,
  deriveKeyFromPassphrase,
  encryptCredential,
  __setCredentialKey,
} from './credential-crypto.js';

describe('credential-crypto', { concurrency: false }, () => {
  afterEach(() => {
    __setCredentialKey(null);
  });

  it('round-trips a plaintext value', () => {
    const plaintext = 'super-secret-token';
    const ciphertext = encryptCredential(plaintext);
    const decrypted = decryptCredential(ciphertext);

    assert.strictEqual(decrypted, plaintext);
    assert.notStrictEqual(ciphertext, plaintext);
  });

  it('produces different ciphertexts for the same plaintext', () => {
    const plaintext = 'super-secret-token';
    const a = encryptCredential(plaintext);
    const b = encryptCredential(plaintext);

    assert.notStrictEqual(a, b);
    assert.strictEqual(decryptCredential(a), plaintext);
    assert.strictEqual(decryptCredential(b), plaintext);
  });

  it('round-trips across instances using a derived key', () => {
    const key = deriveKeyFromPassphrase('test-passphrase');
    __setCredentialKey(key);

    const ciphertext = encryptCredential('cross-instance');
    __setCredentialKey(null);

    __setCredentialKey(deriveKeyFromPassphrase('test-passphrase'));
    assert.strictEqual(decryptCredential(ciphertext), 'cross-instance');
  });

  it('throws when decrypting with the wrong key', () => {
    const keyA = deriveKeyFromPassphrase('passphrase-a');
    const keyB = deriveKeyFromPassphrase('passphrase-b');

    __setCredentialKey(keyA);
    const ciphertext = encryptCredential('tamper-sensitive');

    __setCredentialKey(keyB);
    assert.throws(() => decryptCredential(ciphertext));
  });

  it('throws on too-short ciphertext', () => {
    assert.throws(() => decryptCredential('short'));
  });

  it('throws on ciphertext tampered with after encryption', () => {
    const ciphertext = encryptCredential('authentic');
    const tampered = ciphertext.slice(0, -4) + '0000';

    assert.throws(() => decryptCredential(tampered));
  });

  it('round-trips unicode and empty strings', () => {
    assert.strictEqual(decryptCredential(encryptCredential('')), '');
    assert.strictEqual(
      decryptCredential(encryptCredential('中文 🔐 \n multi-line')),
      '中文 🔐 \n multi-line',
    );
  });
});
