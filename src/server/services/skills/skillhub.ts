import { readBoundedResponse } from './bounded-response.js';
import { sanitizeMetadata } from './sanitize.js';
import type { SkillHubSecurityReport, SkillHubSkillDetail } from './types.js';

const API_BASE = process.env.SKILLHUB_CN_API_URL || 'https://api.skillhub.cn';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_COORDINATE_LENGTH = 128;
const MAX_DISPLAY_TEXT_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 10_000;
const MAX_SECURITY_REPORTS = 16;
const COORDINATE = /^[A-Za-z0-9._-]+$/;
const LINKABLE_SECURITY_PROVIDERS = new Set(['keen']);

export type SkillHubErrorCode = 'invalid-input' | 'not-found' | 'unavailable' | 'invalid-response';
export type SkillHubRecord = Record<string, unknown>;

export class SkillHubProviderError extends Error {
  constructor(
    message: string,
    readonly code: SkillHubErrorCode,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function skillHubRecord(value: unknown): SkillHubRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SkillHubRecord
    : null;
}

export function skillHubText(
  value: unknown,
  options: { maxLength?: number; label?: string } = {},
): string {
  if (typeof value !== 'string') return '';
  const normalized = sanitizeMetadata(value).trim();
  const maxLength = options.maxLength ?? MAX_SUMMARY_LENGTH;
  if (normalized.length > maxLength) {
    throw new SkillHubProviderError(
      `SkillHub ${options.label || 'text'} exceeds the size limit`,
      'invalid-response',
    );
  }
  return normalized;
}

export function skillHubNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function skillHubSummary(value: unknown): string {
  const normalized = skillHubText(value, { label: 'summary' });
  if (!normalized.startsWith('{')) return normalized;
  try {
    const parsed = skillHubRecord(JSON.parse(normalized));
    return skillHubText(parsed?.answer, { label: 'summary' })
      || skillHubText(parsed?.content, { label: 'summary' })
      || normalized;
  } catch {
    return normalized;
  }
}

export function isSkillHubCoordinate(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_COORDINATE_LENGTH
    && COORDINATE.test(value)
    && value !== '.'
    && value !== '..';
}

export function assertSkillHubCoordinate(value: string, label: string): void {
  if (!isSkillHubCoordinate(value)) {
    throw new SkillHubProviderError(`Invalid ${label}`, 'invalid-input');
  }
}

export function normalizeSkillHubHttpsUrl(value: unknown): string | undefined {
  const candidate = skillHubText(value, { maxLength: 2_048, label: 'URL' });
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchSkillHubJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SkillHubProviderError('SkillHub request failed', 'unavailable');
  }

  if (!response.ok) {
    throw new SkillHubProviderError(
      response.status === 404 ? 'SkillHub resource not found' : 'SkillHub request failed',
      response.status === 404 ? 'not-found' : 'unavailable',
      response.status,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, MAX_JSON_BYTES, 'SkillHub response is too large');
  } catch (error) {
    if ((error as Error).message === 'SkillHub response is too large') {
      throw new SkillHubProviderError('SkillHub response is too large', 'invalid-response');
    }
    throw new SkillHubProviderError('SkillHub response could not be read', 'unavailable');
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SkillHubProviderError('SkillHub returned invalid JSON', 'invalid-response');
  }
}

export function normalizeSkillHubSecurityReports(value: unknown): SkillHubSecurityReport[] {
  const reports = skillHubRecord(value);
  if (!reports) return [];
  const entries = Object.entries(reports);
  if (entries.length > MAX_SECURITY_REPORTS) {
    throw new SkillHubProviderError('SkillHub security reports exceed the size limit', 'invalid-response');
  }
  return entries.flatMap(([rawProvider, raw]) => {
    const report = skillHubRecord(raw);
    if (!report) return [];
    const provider = skillHubText(rawProvider, {
      maxLength: MAX_COORDINATE_LENGTH,
      label: 'security provider',
    });
    const reportUrl = LINKABLE_SECURITY_PROVIDERS.has(provider)
      ? normalizeSkillHubHttpsUrl(report.reportUrl)
      : undefined;
    return [{
      provider,
      status: skillHubText(report.status, { maxLength: MAX_DISPLAY_TEXT_LENGTH, label: 'security status' }),
      statusText: skillHubText(report.statusText, { maxLength: MAX_DISPLAY_TEXT_LENGTH, label: 'security status text' }),
      ...(reportUrl ? { reportUrl } : {}),
    }];
  });
}

export async function getSkillHubSkill(namespace: string, slug: string): Promise<SkillHubSkillDetail> {
  assertSkillHubCoordinate(namespace, 'namespace');
  assertSkillHubCoordinate(slug, 'Skill slug');
  const body = skillHubRecord(await fetchSkillHubJson(
    `/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`,
  ));
  const skill = skillHubRecord(body?.skill);
  const responseSlug = skillHubText(body?.slug, {
    maxLength: MAX_COORDINATE_LENGTH,
    label: 'Skill slug',
  });
  const namespaceRecord = skillHubRecord(body?.namespace);
  const responseNamespace = skillHubText(namespaceRecord?.handle, {
    maxLength: MAX_COORDINATE_LENGTH,
    label: 'namespace',
  });
  if (
    !body
    || !skill
    || responseSlug !== slug
    || responseNamespace !== namespace
    || !isSkillHubCoordinate(responseSlug)
    || !isSkillHubCoordinate(responseNamespace)
  ) {
    throw new SkillHubProviderError('SkillHub Skill response is malformed', 'invalid-response');
  }
  const skillSlug = skillHubText(skill.slug, {
    maxLength: MAX_COORDINATE_LENGTH,
    label: 'Skill slug',
  });
  if (skillSlug && skillSlug !== slug) {
    throw new SkillHubProviderError('SkillHub Skill response is malformed', 'invalid-response');
  }
  const owner = skillHubRecord(body.owner);
  const publisher = skillHubRecord(body.publisher);
  const publisherOrgId = skillHubText(publisher?.orgId, {
    maxLength: MAX_COORDINATE_LENGTH,
    label: 'publisher organization',
  });
  if (publisherOrgId && !isSkillHubCoordinate(publisherOrgId)) {
    throw new SkillHubProviderError('SkillHub Skill response is malformed', 'invalid-response');
  }
  const latestVersion = skillHubRecord(body.latestVersion);
  const stats = skillHubRecord(skill.stats);
  return {
    namespace: responseNamespace,
    slug: responseSlug,
    displayName: skillHubText(skill.displayName, {
      maxLength: MAX_DISPLAY_TEXT_LENGTH,
      label: 'Skill display name',
    }) || slug,
    summary: skillHubSummary(skill.summary_zh) || skillHubSummary(skill.summary),
    category: skillHubText(skill.category, {
      maxLength: MAX_DISPLAY_TEXT_LENGTH,
      label: 'Skill category',
    }),
    owner: {
      handle: skillHubText(owner?.handle, {
        maxLength: MAX_COORDINATE_LENGTH,
        label: 'owner handle',
      }) || namespace,
      displayName: skillHubText(owner?.displayName, {
        maxLength: MAX_DISPLAY_TEXT_LENGTH,
        label: 'owner display name',
      }) || namespace,
    },
    ...(publisherOrgId ? { publisher: { orgId: publisherOrgId } } : {}),
    version: skillHubText(latestVersion?.version, {
      maxLength: MAX_DISPLAY_TEXT_LENGTH,
      label: 'Skill version',
    }),
    stats: {
      downloads: skillHubNumber(stats?.downloads),
      installs: skillHubNumber(stats?.installs),
    },
    securityReports: normalizeSkillHubSecurityReports(body.securityReports),
    source: `skillhub-cn:${responseNamespace}/${responseSlug}`,
  };
}

export const skillHubLimits = {
  maxJsonBytes: MAX_JSON_BYTES,
  maxCoordinateLength: MAX_COORDINATE_LENGTH,
  maxDisplayTextLength: MAX_DISPLAY_TEXT_LENGTH,
  maxSummaryLength: MAX_SUMMARY_LENGTH,
  maxSecurityReports: MAX_SECURITY_REPORTS,
};
