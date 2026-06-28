import '../test-utils/test-env.js';

// Force diagnostic logs to mirror to console so this test can inspect the log
// output without depending on asynchronous file-stream flushing.
process.env.COMATE_SIDECAR = '0';

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

  it('does not leak ciphertext in the error or diagnostic log on decrypt failure', () => {
    const keyA = deriveKeyFromPassphrase('passphrase-a');
    const keyB = deriveKeyFromPassphrase('passphrase-b');

    __setCredentialKey(keyA);
    const ciphertext = encryptCredential('do-not-leak');

    __setCredentialKey(keyB);
    let thrown: Error | undefined;
    const logged: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args);
    try {
      decryptCredential(ciphertext);
    } catch (err) {
      thrown = err as Error;
    } finally {
      console.log = originalLog;
    }

    assert.ok(thrown, 'expected decrypt to throw');
    assert.strictEqual(thrown.message, 'Failed to decrypt credential');
    assert.ok(!thrown.message.includes(ciphertext));

    const logText = logged.map((a) => (Array.isArray(a) ? a.join(' ') : String(a))).join('\n');
    assert.ok(logText.includes('Credential decryption failed'));
    assert.ok(logText.includes(`ciphertextLength: ${ciphertext.length}`));
    assert.ok(!logText.includes(ciphertext));
  });
});
