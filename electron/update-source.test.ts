import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFailoverUpdaterAdapter,
  createUpdateSources,
  fetchManifestWithTimeout,
  loadUpdateSources,
  parseUpdaterChannel,
  selectUpdateSources,
  type UpdateBackend,
  type UpdateSource,
} from './update-source';
import type { UpdaterCheckInfo } from './updater';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createUpdateSources', () => {
  it('builds platform-specific manifest probes while preserving the release channel', () => {
    const sources = createUpdateSources('latest-enterprise', 'darwin', 'arm64');

    assert.deepEqual(
      sources.map(({ id, manifestUrl, feed }) => ({ id, manifestUrl, feed })),
      [
        {
          id: 'gitee',
          manifestUrl:
            'https://gitee.com/ai-dvps/comate/releases/download/latest/latest-enterprise-mac.yml',
          feed: {
            provider: 'generic',
            url: 'https://gitee.com/ai-dvps/comate/releases/download/latest',
            channel: 'latest-enterprise',
            useMultipleRangeRequest: false,
          },
        },
        {
          id: 'github',
          manifestUrl:
            'https://github.com/ai-dvps/comate/releases/latest/download/latest-enterprise-mac.yml',
          feed: {
            provider: 'github',
            owner: 'ai-dvps',
            repo: 'comate',
            channel: 'latest-enterprise',
          },
        },
      ],
    );
  });

  it('uses the architecture suffix expected by electron-updater on non-x64 Linux', () => {
    const [gitee] = createUpdateSources('latest', 'linux', 'arm64');
    assert.match(gitee.manifestUrl, /latest-linux-arm64\.yml$/);
  });
});

describe('parseUpdaterChannel', () => {
  it('reads the packaged update channel', () => {
    assert.equal(
      parseUpdaterChannel('provider: github\nowner: ai-dvps\nchannel: latest-enterprise\n'),
      'latest-enterprise',
    );
  });

  it('defaults to latest when the feed omits a channel', () => {
    assert.equal(parseUpdaterChannel('provider: github\nowner: ai-dvps\n'), 'latest');
  });
});

describe('loadUpdateSources', () => {
  it('returns null instead of failing application startup when packaged config cannot be read', () => {
    const warnings: string[] = [];

    const sources = loadUpdateSources({
      readConfig: () => {
        throw new Error('config unavailable');
      },
      platform: 'darwin',
      arch: 'arm64',
      logger: { warn: (message) => warnings.push(message) },
    });

    assert.equal(sources, null);
    assert.match(warnings[0] ?? '', /config unavailable/);
  });
});

describe('fetchManifestWithTimeout', () => {
  const [source] = createUpdateSources('latest', 'win32', 'x64');

  it('returns manifest text and bypasses intermediary caches', async () => {
    let requestedUrl = '';
    const manifest = await fetchManifestWithTimeout(source, async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => 'version: 0.4.5' };
    });

    assert.equal(manifest, 'version: 0.4.5');
    assert.match(requestedUrl, /[?&]noCache=\d+/);
  });

  it('rejects non-success responses', async () => {
    await assert.rejects(
      fetchManifestWithTimeout(source, async () => ({
        ok: false,
        status: 503,
        text: async () => '',
      })),
      /HTTP 503/,
    );
  });

  it('aborts a probe that exceeds its timeout', async () => {
    await assert.rejects(
      fetchManifestWithTimeout(
        source,
        async (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        5,
      ),
      /aborted/,
    );
  });
});

describe('selectUpdateSources', () => {
  const sources = createUpdateSources('latest', 'win32', 'x64');

  it('prefers the source whose valid manifest completes first when versions match', async () => {
    const gitee = deferred<string>();
    const github = deferred<string>();
    const selectionPromise = selectUpdateSources(sources, (source) =>
      source.id === 'gitee' ? gitee.promise : github.promise,
    );

    github.resolve('version: 0.4.5\nfiles: []');
    await Promise.resolve();
    gitee.resolve('version: 0.4.5\nfiles: []');

    const selection = await selectionPromise;
    assert.equal(selection[0]?.id, 'github');
    assert.equal(selection[1]?.id, 'gitee');
  });

  it('uses canonical GitHub first when the mirrors expose different versions', async () => {
    const selection = await selectUpdateSources(sources, async (source) =>
      source.id === 'gitee' ? 'version: 0.4.4' : 'version: 0.4.5',
    );

    assert.equal(selection[0]?.id, 'github');
    assert.equal(selection[1]?.id, 'gitee');
  });

  it('keeps a failed probe as a runtime fallback after selecting the healthy source', async () => {
    const selection = await selectUpdateSources(sources, async (source) => {
      if (source.id === 'github') throw new Error('GitHub timeout');
      return 'version: 0.4.5';
    });

    assert.equal(selection[0]?.id, 'gitee');
    assert.equal(selection[1]?.id, 'github');
  });

  it('does not wait for the full slow-source timeout after Gitee succeeds', async () => {
    const selection = await selectUpdateSources(
      sources,
      (source) =>
        source.id === 'gitee'
          ? Promise.resolve('version: 0.4.5')
          : new Promise(() => undefined),
      5,
    );

    assert.equal(selection[0]?.id, 'gitee');
  });

  it('reports every probe failure when neither source is reachable', async () => {
    await assert.rejects(
      selectUpdateSources(sources, async (source) => {
        throw new Error(`${source.id} offline`);
      }),
      /Gitee: gitee offline.*GitHub: github offline/,
    );
  });
});

class FakeBackend implements UpdateBackend {
  activeSource: UpdateSource['id'] | null = null;
  preparedSource: UpdateSource['id'] | null = null;
  checkCalls: UpdateSource['id'][] = [];
  downloadCalls: UpdateSource['id'][] = [];
  checkBySource = new Map<UpdateSource['id'], UpdaterCheckInfo | null>();
  checkErrorBySource = new Map<UpdateSource['id'], Error>();
  downloadErrorBySource = new Map<UpdateSource['id'], Error>();
  quitCalls = 0;
  private progressHandlers: Array<(progress: { transferred: number; total: number }) => void> = [];

  setFeedURL(feed: UpdateSource['feed']): void {
    this.activeSource = feed.provider === 'generic' ? 'gitee' : 'github';
  }

  async checkForUpdates(): Promise<UpdaterCheckInfo | null> {
    assert.ok(this.activeSource);
    this.checkCalls.push(this.activeSource);
    const error = this.checkErrorBySource.get(this.activeSource);
    if (error) throw error;
    const result = this.checkBySource.get(this.activeSource) ?? null;
    this.preparedSource = this.activeSource;
    return result;
  }

  async downloadUpdate(): Promise<void> {
    assert.ok(this.preparedSource);
    this.downloadCalls.push(this.preparedSource);
    const error = this.downloadErrorBySource.get(this.preparedSource);
    if (error) throw error;
  }

  quitAndInstall(): void {
    this.quitCalls += 1;
  }

  onDownloadProgress(handler: (progress: { transferred: number; total: number }) => void): void {
    this.progressHandlers.push(handler);
  }
}

describe('createFailoverUpdaterAdapter', () => {
  const sources = createUpdateSources('latest', 'win32', 'x64');

  it('falls back to the second source when the selected source check fails', async () => {
    const backend = new FakeBackend();
    backend.checkErrorBySource.set('gitee', new Error('Gitee check failed'));
    backend.checkBySource.set('github', { version: '0.4.5' });
    const adapter = createFailoverUpdaterAdapter({
      backend,
      selectSources: async () => sources,
    });

    assert.deepEqual(await adapter.checkForUpdates(), { version: '0.4.5' });
    assert.deepEqual(backend.checkCalls, ['gitee', 'github']);
  });

  it('rechecks the same version on the alternate source after a download failure', async () => {
    const backend = new FakeBackend();
    backend.checkBySource.set('gitee', { version: '0.4.5' });
    backend.checkBySource.set('github', { version: '0.4.5' });
    backend.downloadErrorBySource.set('gitee', new Error('Gitee download failed'));
    const adapter = createFailoverUpdaterAdapter({
      backend,
      selectSources: async () => sources,
    });
    let restartCount = 0;
    adapter.onDownloadRestart?.(() => {
      restartCount += 1;
    });

    await adapter.checkForUpdates();
    await adapter.downloadUpdate();

    assert.deepEqual(backend.downloadCalls, ['gitee', 'github']);
    assert.deepEqual(backend.checkCalls, ['gitee', 'github']);
    assert.equal(restartCount, 1);
  });

  it('does not download a different version discovered on the alternate source', async () => {
    const backend = new FakeBackend();
    backend.checkBySource.set('gitee', { version: '0.4.5' });
    backend.checkBySource.set('github', { version: '0.4.6' });
    backend.downloadErrorBySource.set('gitee', new Error('Gitee download failed'));
    const adapter = createFailoverUpdaterAdapter({
      backend,
      selectSources: async () => sources,
    });

    await adapter.checkForUpdates();
    await assert.rejects(adapter.downloadUpdate(), /expected 0\.4\.5, received 0\.4\.6/);
    assert.deepEqual(backend.downloadCalls, ['gitee']);

    await assert.rejects(adapter.downloadUpdate(), /expected 0\.4\.5, received 0\.4\.6/);
    assert.deepEqual(backend.downloadCalls, ['gitee', 'gitee']);
    assert.deepEqual(backend.checkCalls, ['gitee', 'github', 'gitee', 'github']);
  });

  it('does not download when the alternate source no longer exposes the expected version', async () => {
    const backend = new FakeBackend();
    backend.checkBySource.set('gitee', { version: '0.4.5' });
    backend.checkBySource.set('github', null);
    backend.downloadErrorBySource.set('gitee', new Error('Gitee download failed'));
    const adapter = createFailoverUpdaterAdapter({
      backend,
      selectSources: async () => sources,
    });

    await adapter.checkForUpdates();
    await assert.rejects(adapter.downloadUpdate(), /version 0\.4\.5 is not available/);
    assert.deepEqual(backend.downloadCalls, ['gitee']);
  });
});
