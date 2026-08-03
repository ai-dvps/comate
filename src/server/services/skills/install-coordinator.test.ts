import '../../test-utils/test-env.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InstallCoordinator } from './install-coordinator.js';

describe('InstallCoordinator', () => {
  it('serializes mutations that share a scope key', async () => {
    const coordinator = new InstallCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run('project-a', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = coordinator.run('project-a', async () => {
      events.push('second:start');
      events.push('second:end');
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(events, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('allows independent scopes to proceed concurrently', async () => {
    const coordinator = new InstallCoordinator();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinator.run('project-a', async () => {
      events.push('a');
      await gate;
    });
    const second = coordinator.run('project-b', async () => {
      events.push('b');
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(events.sort(), ['a', 'b']);
    release();
    await Promise.all([first, second]);
  });
});
