import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createUpdaterController,
  type UpdaterAdapter,
  type UpdaterCheckInfo,
  type UpdaterDownloadEvent,
} from './updater';

/**
 * U5: the updater state machine is pure logic over an injectable adapter —
 * no Electron runtime required. Scenarios from the plan:
 *  - happy path check → download → progress events → restart install;
 *  - quitAndInstall arms the is_updating grace (prepare_updater_relaunch
 *    parity) and implicit quit paths can discover a downloaded update;
 *  - manifest 404 / signature failure land in a retryable error state that
 *    is logged (never silent);
 *  - a failed download retries through the adapter (electron-updater resumes
 *    interrupted downloads from its cache).
 */

class FakeAdapter implements UpdaterAdapter {
  checkInfo: UpdaterCheckInfo | null = null;
  checkError: Error | null = null;
  downloadError: Error | null = null;
  checkCalls = 0;
  downloadCalls = 0;
  quitAndInstallCalls = 0;
  private progressHandlers: Array<(p: { transferred: number; total: number }) => void> = [];
  private restartHandlers: Array<() => void> = [];

  async checkForUpdates(): Promise<UpdaterCheckInfo | null> {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    return this.checkInfo;
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }

  onDownloadProgress(handler: (p: { transferred: number; total: number }) => void): void {
    this.progressHandlers.push(handler);
  }

  onDownloadRestart(handler: () => void): void {
    this.restartHandlers.push(handler);
  }

  emitProgress(transferred: number, total: number): void {
    for (const handler of this.progressHandlers) {
      handler({ transferred, total });
    }
  }

  emitDownloadRestart(): void {
    for (const handler of this.restartHandlers) handler();
  }
}

function createHarness() {
  const adapter = new FakeAdapter();
  const events: UpdaterDownloadEvent[] = [];
  const logLines: string[] = [];
  let armCount = 0;
  const controller = createUpdaterController({
    adapter,
    currentVersion: '0.0.33',
    logger: {
      info: (m: string) => logLines.push(`[info] ${m}`),
      warn: (m: string) => logLines.push(`[warn] ${m}`),
      error: (m: string) => logLines.push(`[error] ${m}`),
    },
    onDownloadEvent: (event) => events.push(event),
    armUpdateGrace: () => {
      armCount += 1;
    },
  });
  return {
    adapter,
    events,
    logLines,
    controller,
    armCount: () => armCount,
  };
}

describe('check', () => {
  it('transitions idle → available and returns the update info', async () => {
    const { adapter, controller } = createHarness();
    adapter.checkInfo = { version: '0.0.34', body: 'notes', date: '2026-08-07' };

    assert.strictEqual(controller.getState().status, 'idle');
    const info = await controller.check();

    assert.deepStrictEqual(info, {
      currentVersion: '0.0.33',
      version: '0.0.34',
      body: 'notes',
      date: '2026-08-07',
    });
    assert.strictEqual(controller.getState().status, 'available');
    assert.strictEqual(controller.getState().error, null);
  });

  it('resolves null and returns to idle when no update is available', async () => {
    const { controller } = createHarness();
    const info = await controller.check();
    assert.strictEqual(info, null);
    assert.strictEqual(controller.getState().status, 'idle');
  });

  it('rejects with a manifest error, keeps a retryable error state, and recovers on the next check', async () => {
    const { adapter, controller, logLines } = createHarness();
    adapter.checkError = new Error('Cannot find latest.yml in the release assets (404)');

    await assert.rejects(controller.check(), /404/);
    assert.strictEqual(controller.getState().status, 'error');
    assert.match(controller.getState().error ?? '', /404/);
    // Never silent: the failure hits the shell log.
    assert.ok(logLines.some((l) => l.startsWith('[error]') && l.includes('404')));

    // Retryable: the next check re-enters the adapter and can succeed.
    adapter.checkError = null;
    adapter.checkInfo = { version: '0.0.34' };
    const second = await controller.check();
    assert.strictEqual(second?.version, '0.0.34');
    assert.strictEqual(controller.getState().status, 'available');
    assert.strictEqual(adapter.checkCalls, 2);
  });

  it('dedupes concurrent checks into one adapter call', async () => {
    const { adapter, controller } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    const [a, b] = await Promise.all([controller.check(), controller.check()]);
    assert.strictEqual(a?.version, '0.0.34');
    assert.deepStrictEqual(b, a);
    assert.strictEqual(adapter.checkCalls, 1);
  });

  it('returns the known update without re-checking while downloading or downloaded', async () => {
    const { adapter, controller } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();

    const downloadPromise = controller.download();
    adapter.emitProgress(50, 100);
    const duringDownload = await controller.check();
    assert.strictEqual(duringDownload?.version, '0.0.34');
    await downloadPromise;

    const afterDownload = await controller.check();
    assert.strictEqual(afterDownload?.version, '0.0.34');
    assert.strictEqual(adapter.checkCalls, 1);
  });
});

describe('download', () => {
  it('emits Started with the first-progress total, Progress deltas, and Finished', async () => {
    const { adapter, controller, events } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();

    const downloadPromise = controller.download();
    assert.strictEqual(controller.getState().status, 'downloading');
    // electron-updater reports cumulative transferred bytes; the client event
    // contract expects per-chunk deltas (plugin-updater parity).
    adapter.emitProgress(40, 100);
    adapter.emitProgress(100, 100);
    await downloadPromise;

    assert.deepStrictEqual(events, [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ]);
    assert.strictEqual(controller.getState().status, 'downloaded');
  });

  it('starts progress over when the adapter switches update sources', async () => {
    const { adapter, controller, events } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();

    const downloadPromise = controller.download();
    adapter.emitProgress(40, 100);
    adapter.emitDownloadRestart();
    adapter.emitProgress(10, 100);
    await downloadPromise;

    assert.deepStrictEqual(events, [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 10 } },
      { event: 'Finished' },
    ]);
  });

  it('rejects when no update is available', async () => {
    const { adapter, controller } = createHarness();
    await assert.rejects(controller.download(), /no update/i);
    assert.strictEqual(adapter.downloadCalls, 0);
  });

  it('is idempotent once downloaded (no second adapter download)', async () => {
    const { adapter, controller, events } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();
    await controller.download();
    assert.strictEqual(events.filter((e) => e.event === 'Finished').length, 1);

    await controller.download();
    assert.strictEqual(adapter.downloadCalls, 1);
    // A late subscriber still learns the download finished.
    assert.strictEqual(events.filter((e) => e.event === 'Finished').length, 2);
  });

  it('enters a retryable error state on signature failure and a retry resumes the download', async () => {
    const { adapter, controller, logLines } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();

    adapter.downloadError = new Error('sha512 checksum mismatch');
    await assert.rejects(controller.download(), /sha512/);
    assert.strictEqual(controller.getState().status, 'error');
    assert.match(controller.getState().error ?? '', /sha512/);
    // The update stays attached so the error state can retry the download.
    assert.strictEqual(controller.getState().update?.version, '0.0.34');
    assert.ok(logLines.some((l) => l.startsWith('[error]') && l.includes('sha512')));

    // Retry: electron-updater resumes interrupted downloads from its cache,
    // so the retry goes straight back to downloadUpdate.
    adapter.downloadError = null;
    await controller.download();
    assert.strictEqual(adapter.downloadCalls, 2);
    assert.strictEqual(controller.getState().status, 'downloaded');
  });
});

describe('relaunch', () => {
  it('arms the update grace BEFORE quitAndInstall (prepare_updater_relaunch parity)', async () => {
    const { adapter, controller, armCount } = createHarness();
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();
    await controller.download();

    assert.strictEqual(armCount(), 0);
    controller.relaunch();
    assert.strictEqual(armCount(), 1);
    assert.strictEqual(adapter.quitAndInstallCalls, 1);
  });

  it('rejects without a downloaded update and does not arm the grace', async () => {
    const { adapter, controller, armCount } = createHarness();
    assert.throws(() => controller.relaunch(), /no downloaded update/i);
    assert.strictEqual(armCount(), 0);
    assert.strictEqual(adapter.quitAndInstallCalls, 0);
  });
});

describe('hasDownloadedUpdate (implicit install-on-quit arming)', () => {
  it('is false until the download completes, true afterwards', async () => {
    const { adapter, controller } = createHarness();
    assert.strictEqual(controller.hasDownloadedUpdate(), false);
    adapter.checkInfo = { version: '0.0.34' };
    await controller.check();
    assert.strictEqual(controller.hasDownloadedUpdate(), false);
    await controller.download();
    assert.strictEqual(controller.hasDownloadedUpdate(), true);
  });
});
