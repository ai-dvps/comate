/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  initializeResolvedShellEnv,
  getResolvedShellEnv,
  __resetCache,
  __setSpawnForTesting,
  __restoreSpawn,
  __setShellInitCommandForTesting,
  __restoreShellInitCommand,
  __setNvmDirForTesting,
  __restoreNvmDir,
} from './resolve-shell-env.js';

describe('resolve-shell-env', { concurrency: false }, () => {
  beforeEach(() => {
    __resetCache();
  });

  afterEach(() => {
    __resetCache();
    __restoreSpawn();
    __restoreShellInitCommand();
    __restoreNvmDir();
  });

  function createMockSpawn(stdoutData: string, exitCode = 0, delay = 0) {
    return (..._args: unknown[]): ChildProcess => {
      const proc = new EventEmitter() as ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).stdout = stdout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).stderr = stderr;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).kill = () => {};

      setTimeout(() => {
        if (stdoutData) {
          stdout.emit('data', Buffer.from(stdoutData));
        }
        proc.emit('close', exitCode);
      }, delay);

      return proc;
    };
  }

  function createMockSpawnError(err: Error) {
    return (..._args: unknown[]): ChildProcess => {
      const proc = new EventEmitter() as ChildProcess;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).stdout = stdout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).stderr = stderr;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (proc as any).kill = () => {};

      setTimeout(() => {
        proc.emit('error', err);
      }, 0);

      return proc;
    };
  }

  it('captures environment variables from a successful shell spawn', async () => {
    const envOutput = 'PATH=/usr/local/bin:/usr/bin\0HOME=/home/user\0FOO=bar\0';
    __setSpawnForTesting(createMockSpawn(envOutput, 0) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.ok(env);
    assert.strictEqual(env?.PATH, '/usr/local/bin:/usr/bin');
    assert.strictEqual(env?.HOME, '/home/user');
    assert.strictEqual(env?.FOO, 'bar');
  });

  it('handles multi-line values with embedded newlines', async () => {
    const envOutput = 'MULTI=line1\nline2\nline3\0PATH=/bin\0';
    __setSpawnForTesting(createMockSpawn(envOutput, 0) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.ok(env);
    assert.strictEqual(env?.MULTI, 'line1\nline2\nline3');
    assert.strictEqual(env?.PATH, '/bin');
  });

  it('splits only on the first equals sign', async () => {
    const envOutput = 'EQUATION=a=b=c\0PATH=/bin\0';
    __setSpawnForTesting(createMockSpawn(envOutput, 0) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.ok(env);
    assert.strictEqual(env?.EQUATION, 'a=b=c');
  });

  it('preserves empty string values', async () => {
    const envOutput = 'EMPTY=\0PATH=/bin\0';
    __setSpawnForTesting(createMockSpawn(envOutput, 0) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.ok(env);
    assert.strictEqual(env?.EMPTY, '');
  });

  it('returns null when the shell exits with a non-zero code', async () => {
    __setSpawnForTesting(createMockSpawn('', 1) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.strictEqual(env, null);
  });

  it('returns null when spawn throws immediately', async () => {
    __setSpawnForTesting(createMockSpawnError(new Error('ENOENT')) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.strictEqual(env, null);
  });

  it('returns an empty record for empty stdout', async () => {
    __setSpawnForTesting(createMockSpawn('', 0) as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.ok(env);
    assert.deepStrictEqual(env, {});
  });

  it('caches the result and does not spawn again on subsequent calls', async () => {
    let spawnCount = 0;
    const trackingSpawn = (..._args: unknown[]): ChildProcess => {
      spawnCount++;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();
    await initializeResolvedShellEnv();
    const env = getResolvedShellEnv();

    assert.strictEqual(spawnCount, 1);
    assert.ok(env);
  });

  it('returns null on Windows without spawning', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      await initializeResolvedShellEnv();
      const env = getResolvedShellEnv();
      assert.strictEqual(env, null);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('uses plain env -0 when no init command and no nvm', async () => {
    __setNvmDirForTesting(undefined);

    let capturedArgs: unknown[] | undefined;
    const trackingSpawn = (...args: unknown[]): ChildProcess => {
      capturedArgs = args;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();

    assert.ok(capturedArgs);
    assert.strictEqual((capturedArgs![1] as string[])[1], 'env -0');
  });

  it('prepends user-configured shellInitCommand before env -0', async () => {
    __setShellInitCommandForTesting('echo setup');

    let capturedArgs: unknown[] | undefined;
    const trackingSpawn = (...args: unknown[]): ChildProcess => {
      capturedArgs = args;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();

    assert.ok(capturedArgs);
    const command = (capturedArgs![1] as string[])[1];
    assert.ok(command.startsWith('echo setup; env -0'));
  });

  it('prepends nvm activation when nvm dir is detected', async () => {
    __setNvmDirForTesting('/home/user/.nvm');

    let capturedArgs: unknown[] | undefined;
    const trackingSpawn = (...args: unknown[]): ChildProcess => {
      capturedArgs = args;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();

    assert.ok(capturedArgs);
    const command = (capturedArgs![1] as string[])[1];
    assert.ok(command.includes('export NVM_DIR="/home/user/.nvm"'));
    assert.ok(command.includes('nvm.sh'));
    assert.ok(command.includes('nvm use;'));
    assert.ok(command.endsWith('; env -0'));
  });

  it('spawns shell from the user home directory', async () => {
    __setNvmDirForTesting('/home/user/.nvm');

    let capturedOpts: Record<string, unknown> | undefined;
    const trackingSpawn = (_cmd: unknown, _args: unknown, opts: Record<string, unknown>): ChildProcess => {
      capturedOpts = opts;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();

    assert.ok(capturedOpts);
    assert.strictEqual(capturedOpts!.cwd, homedir());
  });

  it('user-configured shellInitCommand takes precedence over nvm auto-detection', async () => {
    __setShellInitCommandForTesting('source /custom/init.sh');
    __setNvmDirForTesting('/home/user/.nvm');

    let capturedArgs: unknown[] | undefined;
    const trackingSpawn = (...args: unknown[]): ChildProcess => {
      capturedArgs = args;
      return createMockSpawn('PATH=/bin\0', 0)() as ChildProcess;
    };

    __setSpawnForTesting(trackingSpawn as unknown as typeof import('child_process').spawn);

    await initializeResolvedShellEnv();

    assert.ok(capturedArgs);
    const command = (capturedArgs![1] as string[])[1];
    assert.ok(command.startsWith('source /custom/init.sh; env -0'));
    assert.ok(!command.includes('NVM_DIR'));
  });
});
