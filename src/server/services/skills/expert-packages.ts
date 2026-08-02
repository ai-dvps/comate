import { parseFrontmatter } from './frontmatter.js';
import { sanitizeMetadata } from './sanitize.js';
import { readBoundedResponse } from './bounded-response.js';
import type {
  ExpertPackageChild,
  ExpertPackageDetail,
  ExpertPackageSummary,
  ExpertSkillDetail,
  ExpertSkillSecurityReport,
} from './types.js';

const API_BASE = process.env.SKILLHUB_CN_API_URL || 'https://api.skillhub.cn';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_ORCHESTRATION_BYTES = 256 * 1024;
const MAX_PACKAGE_CHILDREN = 64;
const MAX_PAGE_SIZE = 200;
const CHILD_HYDRATION_CONCURRENCY = 6;
const COORDINATE = /^[A-Za-z0-9._-]+$/;
export const EXPERT_PACKAGE_SCENES = [
  'academic', 'content-creation', 'design', 'ecommerce', 'education', 'finance',
  'healthcare', 'hr', 'legal', 'lifestyle', 'marketing', 'media', 'mysticism', 'tech',
] as const;

export function isExpertPackageScene(value: unknown): value is typeof EXPERT_PACKAGE_SCENES[number] {
  return typeof value === 'string' && (EXPERT_PACKAGE_SCENES as readonly string[]).includes(value);
}

type UnknownRecord = Record<string, unknown>;

export interface ExpertPackageDefinition {
  summary: ExpertPackageSummary;
  content: string;
  contentEn?: string;
  coordinates: Array<{ namespace: string; slug: string }>;
  structurallyComplete: boolean;
}

export class ExpertPackageProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-input' | 'not-found' | 'unavailable' | 'invalid-response',
    readonly status?: number,
  ) {
    super(message);
  }
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? sanitizeMetadata(value).trim() : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summary(value: unknown): string {
  const normalized = text(value);
  if (!normalized.startsWith('{')) return normalized;
  try {
    const parsed = record(JSON.parse(normalized));
    return text(parsed?.answer) || text(parsed?.content) || normalized;
  } catch {
    return normalized;
  }
}

function assertCoordinate(value: string, label: string): void {
  if (!COORDINATE.test(value)) {
    throw new ExpertPackageProviderError(`Invalid ${label}: ${value}`, 'invalid-input');
  }
}

async function fetchJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ExpertPackageProviderError(
      `SkillHub request failed: ${(error as Error).message}`,
      'unavailable',
    );
  }

  if (!response.ok) {
    throw new ExpertPackageProviderError(
      response.status === 404 ? 'SkillHub resource not found' : `SkillHub returned ${response.status}`,
      response.status === 404 ? 'not-found' : 'unavailable',
      response.status,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, MAX_JSON_BYTES, 'SkillHub response is too large');
  } catch (error) {
    if ((error as Error).message === 'SkillHub response is too large') {
      throw new ExpertPackageProviderError('SkillHub response is too large', 'invalid-response');
    }
    throw new ExpertPackageProviderError(
      `SkillHub response could not be read: ${(error as Error).message}`,
      'unavailable',
    );
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ExpertPackageProviderError('SkillHub returned invalid JSON', 'invalid-response');
  }
}

function normalizeSummary(value: unknown): ExpertPackageSummary | null {
  const item = record(value);
  if (!item) return null;
  const slug = text(item.slug);
  if (!COORDINATE.test(slug)) return null;
  const skills = Array.isArray(item.skills) ? item.skills : [];
  return {
    slug,
    displayName: text(item.displayName) || slug,
    ...(text(item.displayNameEn) ? { displayNameEn: text(item.displayNameEn) } : {}),
    summary: text(item.summary),
    ...(text(item.summaryEn) ? { summaryEn: text(item.summaryEn) } : {}),
    scene: text(item.scene),
    ...(text(item.subScene) ? { subScene: text(item.subScene) } : {}),
    skillCount: number(item.skillCount) || skills.length,
    source: 'skillhub.cn',
  };
}

export async function listExpertPackages(input: {
  keyword?: string;
  scene?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ packages: ExpertPackageSummary[]; total: number }> {
  const page = Math.max(1, Math.floor(input.page || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize || 20)));
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (input.keyword?.trim()) params.set('keyword', input.keyword.trim());
  if (input.scene?.trim()) params.set('scene', input.scene.trim());
  const body = record(await fetchJson(`/api/v1/skillsets?${params.toString()}`));
  if (!body || !Array.isArray(body.skillSets)) {
    throw new ExpertPackageProviderError('SkillHub package list is malformed', 'invalid-response');
  }
  return {
    packages: body.skillSets.map(normalizeSummary).filter((item): item is ExpertPackageSummary => Boolean(item)),
    total: number(body.total),
  };
}

function normalizeSecurityReports(value: unknown): ExpertSkillSecurityReport[] {
  const reports = record(value);
  if (!reports) return [];
  return Object.entries(reports).flatMap(([provider, raw]) => {
    const report = record(raw);
    if (!report) return [];
    const reportUrl = text(report.reportUrl);
    return [{
      provider: sanitizeMetadata(provider),
      status: text(report.status),
      statusText: text(report.statusText),
      ...(reportUrl.startsWith('http://') || reportUrl.startsWith('https://') ? { reportUrl } : {}),
    }];
  });
}

export async function getExpertSkill(namespace: string, slug: string): Promise<ExpertSkillDetail> {
  assertCoordinate(namespace, 'namespace');
  assertCoordinate(slug, 'Skill slug');
  const body = record(await fetchJson(
    `/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`,
  ));
  const skill = record(body?.skill);
  if (!body || !skill || text(body.slug) !== slug) {
    throw new ExpertPackageProviderError('SkillHub Skill response is malformed', 'invalid-response');
  }
  const owner = record(body.owner);
  const namespaceRecord = record(body.namespace);
  const latestVersion = record(body.latestVersion);
  const stats = record(skill.stats);
  return {
    namespace: text(namespaceRecord?.handle) || namespace,
    slug,
    displayName: text(skill.displayName) || slug,
    summary: summary(skill.summary_zh) || summary(skill.summary),
    category: text(skill.category),
    owner: {
      handle: text(owner?.handle) || namespace,
      displayName: text(owner?.displayName) || namespace,
    },
    version: text(latestVersion?.version),
    stats: {
      downloads: number(stats?.downloads),
      installs: number(stats?.installs),
    },
    securityReports: normalizeSecurityReports(body.securityReports),
    source: `skillhub-cn:${namespace}/${slug}`,
  };
}

async function hydrateChildren(
  coordinates: Array<{ namespace: string; slug: string }>,
): Promise<ExpertPackageChild[]> {
  const results: ExpertPackageChild[] = [];
  for (let index = 0; index < coordinates.length; index += CHILD_HYDRATION_CONCURRENCY) {
    const chunk = coordinates.slice(index, index + CHILD_HYDRATION_CONCURRENCY);
    results.push(...await Promise.all(chunk.map(async ({ namespace, slug }) => {
      try {
        const skill = await getExpertSkill(namespace, slug);
        return {
          namespace,
          slug,
          displayName: skill.displayName,
          summary: skill.summary,
          available: true,
          source: skill.source,
          securityReports: skill.securityReports,
        };
      } catch {
        return {
          namespace,
          slug,
          displayName: slug,
          summary: '',
          available: false,
          source: `skillhub-cn:${namespace}/${slug}`,
          securityReports: [],
        };
      }
    })));
  }
  return results;
}

export async function getExpertPackageDefinition(slug: string): Promise<ExpertPackageDefinition> {
  assertCoordinate(slug, 'package slug');
  const body = record(await fetchJson(`/api/v1/skillsets/${encodeURIComponent(slug)}`));
  const summary = normalizeSummary(body);
  if (!body || !summary || summary.slug !== slug) {
    throw new ExpertPackageProviderError('SkillHub package response is malformed', 'invalid-response');
  }
  const content = typeof body.content === 'string' ? body.content : '';
  const contentEn = typeof body.contentEn === 'string' ? body.contentEn : '';
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const contentEnBytes = new TextEncoder().encode(contentEn).byteLength;
  const rawSkills = Array.isArray(body.skills) ? body.skills : [];
  if (
    rawSkills.length > MAX_PACKAGE_CHILDREN
    || contentBytes > MAX_ORCHESTRATION_BYTES
    || contentEnBytes > MAX_ORCHESTRATION_BYTES
  ) {
    throw new ExpertPackageProviderError('SkillHub package exceeds safety limits', 'invalid-response');
  }
  const coordinates = rawSkills.flatMap((raw) => {
    const child = record(raw);
    const namespace = text(child?.namespace);
    const childSlug = text(child?.slug);
    return COORDINATE.test(namespace) && COORDINATE.test(childSlug)
      ? [{ namespace, slug: childSlug }]
      : [];
  });
  const frontmatterName = text(parseFrontmatter(content).data.name);
  const installNames = coordinates.map((coordinate) => coordinate.slug);
  const hasInstallNameCollision = new Set(installNames).size !== installNames.length
    || installNames.includes(slug);
  const structurallyComplete = Boolean(
    content &&
    frontmatterName === slug &&
    coordinates.length > 0 &&
    coordinates.length === rawSkills.length &&
    !hasInstallNameCollision,
  );
  return {
    summary,
    content,
    ...(contentEn ? { contentEn } : {}),
    coordinates,
    structurallyComplete,
  };
}

export async function getExpertPackage(slug: string): Promise<ExpertPackageDetail> {
  const definition = await getExpertPackageDefinition(slug);
  const children = await hydrateChildren(definition.coordinates);
  const complete = definition.structurallyComplete && children.every((child) => child.available);
  return {
    ...definition.summary,
    skillCount: definition.coordinates.length,
    content: definition.content,
    ...(definition.contentEn ? { contentEn: definition.contentEn } : {}),
    children,
    complete,
    ...(!complete ? { unavailableReason: 'Package orchestration or included Skills are unavailable.' } : {}),
  };
}

export const expertPackageLimits = {
  maxJsonBytes: MAX_JSON_BYTES,
  maxOrchestrationBytes: MAX_ORCHESTRATION_BYTES,
  maxPackageChildren: MAX_PACKAGE_CHILDREN,
  maxPageSize: MAX_PAGE_SIZE,
};
