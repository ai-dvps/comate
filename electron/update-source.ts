import { GITEE_UPDATE_FEED, UPDATE_FEED } from '../src/shared/updater-contract';
import type { GenericServerOptions, GithubOptions } from 'builder-util-runtime';
import {
  updaterErrorMessage,
  type UpdaterAdapter,
  type UpdaterCheckInfo,
  type UpdaterLogger,
} from './updater';

export type UpdateSourceId = 'gitee' | 'github';

export type UpdateFeed =
  | (GenericServerOptions & { url: string; channel: string })
  | (GithubOptions & { owner: string; repo: string; channel: string });

export interface UpdateSource {
  id: UpdateSourceId;
  label: string;
  manifestUrl: string;
  feed: UpdateFeed;
}

export interface UpdateBackend extends Omit<UpdaterAdapter, 'onDownloadRestart'> {
  setFeedURL(feed: UpdateFeed): void;
}

export type ManifestFetch = (
  url: string,
  init: Pick<RequestInit, 'signal'> & { signal: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

function manifestFilename(channel: string, platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return `${channel}-mac.yml`;
  if (platform === 'linux') {
    const archSuffix = arch === 'x64' ? '' : `-${arch}`;
    return `${channel}-linux${archSuffix}.yml`;
  }
  return `${channel}.yml`;
}

export function createUpdateSources(
  channel: string,
  platform: NodeJS.Platform,
  arch: string,
): UpdateSource[] {
  const manifest = manifestFilename(channel, platform, arch);
  return [
    {
      id: 'gitee',
      label: 'Gitee',
      manifestUrl: `${GITEE_UPDATE_FEED.url}/${manifest}`,
      feed: { ...GITEE_UPDATE_FEED, channel },
    },
    {
      id: 'github',
      label: 'GitHub',
      manifestUrl: `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases/latest/download/${manifest}`,
      feed: { ...UPDATE_FEED, channel },
    },
  ];
}

function parseUpdaterYamlScalar(document: string, key: 'channel' | 'version'): string | null {
  const match = new RegExp(
    `^\\s*${key}:\\s*["']?([^\\s"'#]+)["']?\\s*(?:#.*)?$`,
    'm',
  ).exec(document);
  return match?.[1] ?? null;
}

export function parseUpdaterChannel(config: string): string {
  return parseUpdaterYamlScalar(config, 'channel') ?? 'latest';
}

export function loadUpdateSources(deps: {
  readConfig(): string;
  platform: NodeJS.Platform;
  arch: string;
  logger?: Pick<UpdaterLogger, 'warn'>;
}): UpdateSource[] | null {
  try {
    return createUpdateSources(
      parseUpdaterChannel(deps.readConfig()),
      deps.platform,
      deps.arch,
    );
  } catch (error) {
    deps.logger?.warn(`Unable to read packaged update config: ${updaterErrorMessage(error)}`);
    return null;
  }
}

function parseManifestVersion(manifest: string): string {
  const version = parseUpdaterYamlScalar(manifest, 'version');
  if (!version) throw new Error('manifest does not contain a valid version');
  return version;
}

interface ProbeResult {
  source: UpdateSource;
  version?: string;
  error?: unknown;
}

function sourcesError(action: string, failures: Array<{ source: UpdateSource; error: unknown }>): Error {
  const details = failures
    .map(({ source, error }) => `${source.label}: ${updaterErrorMessage(error)}`)
    .join('; ');
  return new Error(`${action} failed for all update sources — ${details}`);
}

/**
 * Probe both manifests. Matching versions use the fastest valid response;
 * mismatched mirrors use canonical GitHub first so a stale mirror cannot
 * suppress a newly published release. Unhealthy probes remain fallbacks for
 * a later updater-level retry because their outage may be transient.
 */
export async function selectUpdateSources(
  sources: UpdateSource[],
  fetchManifest: (source: UpdateSource) => Promise<string>,
  comparisonGraceMs = 1_500,
): Promise<UpdateSource[]> {
  const pending = new Map(
    sources.map((source) => {
      const promise = (async (): Promise<ProbeResult> => {
        try {
          const version = parseManifestVersion(await fetchManifest(source));
          return { source, version };
        } catch (error) {
          return { source, error };
        }
      })();
      return [source.id, promise] as const;
    }),
  );
  const failures: Array<{ source: UpdateSource; error: unknown }> = [];

  while (pending.size > 0) {
    const first = await Promise.race(pending.values());
    pending.delete(first.source.id);
    if (!first.version) {
      failures.push({ source: first.source, error: first.error });
      continue;
    }

    let primary = first.source;
    // GitHub is canonical. When Gitee wins the race, allow a short grace for
    // GitHub to expose version skew, without waiting for its full timeout.
    const githubProbe = pending.get('github');
    if (first.source.id === 'gitee' && githubProbe) {
      const graceExpired = Symbol('grace-expired');
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const comparison = await Promise.race([
        githubProbe,
        new Promise<typeof graceExpired>((resolve) => {
          graceTimer = setTimeout(() => resolve(graceExpired), comparisonGraceMs);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (comparison !== graceExpired) {
        pending.delete('github');
        if (comparison.version && comparison.version !== first.version) {
          primary = comparison.source;
        }
      }
    }
    return [primary, ...sources.filter((source) => source.id !== primary.id)];
  }
  throw sourcesError('Update source probe', failures);
}

export async function fetchManifestWithTimeout(
  source: UpdateSource,
  fetcher: ManifestFetch,
  timeoutMs = 6_000,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const manifestUrl = new URL(source.manifestUrl);
    manifestUrl.searchParams.set('noCache', String(Date.now()));
    const response = await fetcher(manifestUrl.href, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function createFailoverUpdaterAdapter(deps: {
  backend: UpdateBackend;
  selectSources(): Promise<UpdateSource[]>;
  logger?: UpdaterLogger;
}): UpdaterAdapter {
  const logger = deps.logger;
  let orderedSources: UpdateSource[] = [];
  let activeSource: UpdateSource | null = null;
  let preparedSourceId: UpdateSourceId | null = null;
  let expectedVersion: string | null = null;
  const downloadRestartHandlers: Array<() => void> = [];

  async function checkForUpdates(): Promise<UpdaterCheckInfo | null> {
    orderedSources = await deps.selectSources();
    const failures: Array<{ source: UpdateSource; error: unknown }> = [];
    for (const source of orderedSources) {
      deps.backend.setFeedURL(source.feed);
      preparedSourceId = null;
      try {
        const result = await deps.backend.checkForUpdates();
        activeSource = source;
        preparedSourceId = source.id;
        expectedVersion = result?.version ?? null;
        logger?.info(`Update source selected: ${source.label}`);
        return result;
      } catch (error) {
        failures.push({ source, error });
        logger?.warn(`Update check via ${source.label} failed: ${updaterErrorMessage(error)}`);
      }
    }
    activeSource = null;
    expectedVersion = null;
    throw sourcesError('Update check', failures);
  }

  async function downloadUpdate(): Promise<void> {
    if (!activeSource || !expectedVersion) {
      throw new Error('No update source selected — run check first');
    }
    const candidates = [
      activeSource,
      ...orderedSources.filter((source) => source.id !== activeSource?.id),
    ];
    const failures: Array<{ source: UpdateSource; error: unknown }> = [];

    for (const [index, source] of candidates.entries()) {
      if (preparedSourceId !== source.id) {
        deps.backend.setFeedURL(source.feed);
        preparedSourceId = null;
        try {
          const alternate = await deps.backend.checkForUpdates();
          if (!alternate) throw new Error(`version ${expectedVersion} is not available`);
          if (alternate.version !== expectedVersion) {
            throw new Error(`expected ${expectedVersion}, received ${alternate.version}`);
          }
          preparedSourceId = source.id;
        } catch (error) {
          failures.push({ source, error });
          logger?.warn(
            `Update fallback check via ${source.label} failed: ${updaterErrorMessage(error)}`,
          );
          continue;
        }
      }
      if (index > 0) {
        activeSource = source;
        for (const handler of downloadRestartHandlers) handler();
        logger?.info(`Retrying update download via ${source.label}`);
      }

      try {
        await deps.backend.downloadUpdate();
        return;
      } catch (error) {
        failures.push({ source, error });
        logger?.warn(`Update download via ${source.label} failed: ${updaterErrorMessage(error)}`);
      }
    }
    throw sourcesError('Update download', failures);
  }

  return {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall: () => deps.backend.quitAndInstall(),
    onDownloadProgress: (handler) => deps.backend.onDownloadProgress(handler),
    onDownloadRestart: (handler) => downloadRestartHandlers.push(handler),
  };
}
