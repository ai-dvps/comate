import { readBoundedResponse } from './bounded-response.js';
import { sanitizeMetadata } from './sanitize.js';
import { createHash } from 'node:crypto';

export const WESKILLHUB_JSON_MAX_BYTES = 1024 * 1024;
export const WESKILLHUB_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_WESKILLHUB_API_URL = 'http://weskillhub.weoa.com/api/v1';
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const RESPONSE_TOO_LARGE_SENTINEL = 'WESKILLHUB_RESPONSE_TOO_LARGE';

export type WeSkillHubErrorCategory =
  | 'configuration'
  | 'network'
  | 'timeout'
  | 'http'
  | 'response-too-large'
  | 'invalid-response'
  | 'provider'
  | 'archive';

const PUBLIC_ERROR_MESSAGES: Record<WeSkillHubErrorCategory, string> = {
  configuration: 'WeSkillHub configuration error',
  network: 'WeSkillHub network error',
  timeout: 'WeSkillHub timeout',
  http: 'WeSkillHub HTTP error',
  'response-too-large': 'WeSkillHub response too large',
  'invalid-response': 'WeSkillHub invalid response',
  provider: 'WeSkillHub provider error',
  archive: 'WeSkillHub archive error',
};

export class WeSkillHubError extends Error {
  constructor(readonly category: WeSkillHubErrorCategory) {
    super(PUBLIC_ERROR_MESSAGES[category]);
    this.name = 'WeSkillHubError';
  }
}

export interface WeSkillHubSearchRecord {
  id: number;
  name: string;
  slug: string;
  description: string;
  downloads: number;
  updatedAt?: number;
}

export type WeSkillHubSearchSort = 'hot' | 'downloads' | 'update_date';

export interface WeSkillHubMaterializationTransaction {
  readonly id: number;
  readonly slug: string;
  readonly version: string;
  readonly fileSize: number;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface WeSkillHubClient {
  searchSkills(input: { search: string; sort: WeSkillHubSearchSort }): Promise<WeSkillHubSearchRecord[]>;
  resolveLatestVersion(input: { id: number; slug: string }): Promise<WeSkillHubMaterializationTransaction>;
  downloadExactVersion(transaction: WeSkillHubMaterializationTransaction): Promise<Uint8Array>;
}

interface WeSkillHubClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
}

export function normalizeWeSkillHubBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || value.includes('?')
      || value.includes('#')) {
      throw new WeSkillHubError('configuration');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url.toString();
  } catch (error) {
    if (error instanceof WeSkillHubError) throw error;
    throw new WeSkillHubError('configuration');
  }
}

export function buildWeSkillHubUrl(
  normalizedBaseUrl: string,
  pathSegments: readonly string[],
  searchParams?: URLSearchParams,
): URL {
  const base = new URL(normalizeWeSkillHubBaseUrl(normalizedBaseUrl));
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');
  const url = new URL(encodedPath, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new WeSkillHubError('configuration');
  }
  if (searchParams) url.search = searchParams.toString();
  return url;
}

export function createWeSkillHubClient(options: WeSkillHubClientOptions = {}): WeSkillHubClient {
  const baseUrl = normalizeWeSkillHubBaseUrl(
    options.baseUrl || process.env.WESKILLHUB_API_URL || DEFAULT_WESKILLHUB_API_URL,
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  async function requestJson(pathSegments: readonly string[], searchParams?: URLSearchParams): Promise<unknown> {
    const url = buildWeSkillHubUrl(baseUrl, pathSegments, searchParams);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new WeSkillHubError(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
      );
    }
    if (!response.ok) throw new WeSkillHubError('http');

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponse(
        response,
        WESKILLHUB_JSON_MAX_BYTES,
        RESPONSE_TOO_LARGE_SENTINEL,
      );
    } catch (error) {
      if (error instanceof Error && error.message === RESPONSE_TOO_LARGE_SENTINEL) {
        throw new WeSkillHubError('response-too-large');
      }
      throw new WeSkillHubError('invalid-response');
    }

    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new WeSkillHubError('invalid-response');
    }
  }

  return {
    async searchSkills(input) {
      const params = new URLSearchParams({
        search: input.search,
        page: '1',
        page_size: '10',
        sort_by: input.sort,
      });
      const body = await requestJson(['skills'], params);
      if (!isRecord(body)) throw new WeSkillHubError('invalid-response');
      if (body.code !== '0') throw new WeSkillHubError('provider');
      if (!isRecord(body.data) || !Array.isArray(body.data.data)) {
        throw new WeSkillHubError('invalid-response');
      }
      return body.data.data.flatMap(normalizeSearchRecord);
    },
    async resolveLatestVersion(input) {
      if (!Number.isSafeInteger(input.id) || input.id <= 0 || !isSafeSlug(input.slug)) {
        throw new WeSkillHubError('invalid-response');
      }
      const body = await requestJson(['skills', String(input.id), 'versions']);
      if (!isRecord(body)) throw new WeSkillHubError('invalid-response');
      if (body.code !== '0') throw new WeSkillHubError('provider');
      if (!isRecord(body.data) || !Array.isArray(body.data.versions)) {
        throw new WeSkillHubError('invalid-response');
      }

      const latest = body.data.versions.filter((value) => isRecord(value) && value.is_latest === true);
      if (latest.length !== 1) throw new WeSkillHubError('invalid-response');
      const selected = latest[0]!;
      if (typeof selected.version !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(selected.version)
        || typeof selected.file_size !== 'number'
        || !Number.isSafeInteger(selected.file_size)
        || selected.file_size < 0
        || selected.file_size > WESKILLHUB_ARCHIVE_MAX_BYTES
        || typeof selected.sha256 !== 'string'
        || !/^[A-Fa-f0-9]{64}$/.test(selected.sha256)) {
        throw new WeSkillHubError('invalid-response');
      }

      const downloadUrl = buildWeSkillHubUrl(
        baseUrl,
        ['skills', input.slug, 'download'],
        new URLSearchParams({ version: selected.version }),
      ).toString();
      return Object.freeze({
        id: input.id,
        slug: input.slug,
        version: selected.version,
        fileSize: selected.file_size,
        sha256: selected.sha256.toLowerCase(),
        downloadUrl,
      });
    },
    async downloadExactVersion(transaction) {
      const expectedUrl = buildWeSkillHubUrl(
        baseUrl,
        ['skills', transaction.slug, 'download'],
        new URLSearchParams({ version: transaction.version }),
      ).toString();
      if (transaction.downloadUrl !== expectedUrl) throw new WeSkillHubError('archive');

      let response: Response;
      try {
        response = await fetchImpl(expectedUrl, {
          headers: { Accept: 'application/zip, application/x-zip-compressed, application/octet-stream' },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(downloadTimeoutMs),
        });
      } catch (error) {
        throw new WeSkillHubError(
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
        );
      }
      if (!response.ok) throw new WeSkillHubError('http');
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/zip'
        && contentType !== 'application/x-zip-compressed'
        && contentType !== 'application/octet-stream') {
        throw new WeSkillHubError('archive');
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponse(
          response,
          WESKILLHUB_ARCHIVE_MAX_BYTES,
          RESPONSE_TOO_LARGE_SENTINEL,
        );
      } catch (error) {
        if (error instanceof Error && error.message === RESPONSE_TOO_LARGE_SENTINEL) {
          throw new WeSkillHubError('response-too-large');
        }
        throw new WeSkillHubError('archive');
      }
      if (bytes.byteLength !== transaction.fileSize) throw new WeSkillHubError('archive');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== transaction.sha256) throw new WeSkillHubError('archive');
      return bytes;
    },
  };
}

function normalizeSearchRecord(value: unknown): WeSkillHubSearchRecord[] {
  if (!isRecord(value)
    || typeof value.id !== 'number'
    || !Number.isSafeInteger(value.id)
    || value.id <= 0
    || typeof value.name !== 'string'
    || typeof value.slug !== 'string') {
    return [];
  }

  const name = sanitizeMetadata(value.name);
  const slug = sanitizeMetadata(value.slug);
  if (!name || !isSafeSlug(slug)) return [];

  const description = typeof value.description === 'string'
    ? sanitizeMetadata(value.description)
    : '';
  const downloads = typeof value.downloads === 'number'
    && Number.isSafeInteger(value.downloads)
    && value.downloads >= 0
    ? value.downloads
    : 0;
  const updatedAt = typeof value.update_date === 'string'
    ? parseProviderDate(value.update_date)
    : Number.NaN;

  return [{
    id: value.id,
    name,
    slug,
    description,
    downloads,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }];
}

function parseProviderDate(value: string): number {
  const trimmed = value.trim();
  const withoutZone = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(trimmed);
  return Date.parse(withoutZone ? `${withoutZone[1]}T${withoutZone[2]}Z` : trimmed);
}

function isSafeSlug(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
