import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { waitForChildProcessClose } from './process-cleanup.js';

describe('waitForChildProcessClose', () => {
  it('resolves only after the child close event releases its stdio handles', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let closed = false;
    child.once('close', () => {
      closed = true;
    });
    const closePromise = waitForChildProcessClose(child);

    child.kill('SIGKILL');
    await closePromise;

    assert.strictEqual(closed, true);
  });
});
