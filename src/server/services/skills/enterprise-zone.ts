import {
  assertSkillHubCoordinate,
  fetchSkillHubJson,
  getSkillHubSkill,
  isSkillHubCoordinate,
  normalizeSkillHubHttpsUrl,
  SkillHubProviderError,
  skillHubRecord,
  skillHubSummary,
  skillHubText,
} from './skillhub.js';
import type {
  EnterpriseDetail,
  EnterpriseIndustry,
  EnterprisePage,
  EnterpriseSkillPage,
  EnterpriseSkillSort,
  EnterpriseSkillSummary,
  EnterpriseSummary,
  SkillHubSkillDetail,
} from './types.js';

const PAGE_SIZE = 20;
const MAX_INDUSTRIES = 128;
const MAX_INDUSTRY_TAGS = 32;
const MAX_TOTAL = 1_000_000;
const MAX_USAGE_COUNT = 1_000_000_000_000;
const MAX_PAGE = 50_000;
const MAX_QUERY_LENGTH = 200;
const INDUSTRY = /^[a-z0-9_]{1,64}$/;
const SORTS = new Set<EnterpriseSkillSort>(['downloads', 'stars', 'latest']);

function invalidResponse(message: string): never {
  throw new SkillHubProviderError(message, 'invalid-response');
}

function validCount(value: unknown, max = MAX_TOTAL): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function normalizePage(value: number | undefined): number {
  const page = value ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new SkillHubProviderError('Invalid page', 'invalid-input');
  }
  return page;
}

function normalizeKeyword(value: string | undefined): string {
  const keyword = value?.trim() ?? '';
  if (keyword.length > MAX_QUERY_LENGTH) {
    throw new SkillHubProviderError('Invalid keyword', 'invalid-input');
  }
  return keyword;
}

export function isEnterpriseIndustry(value: unknown): value is string {
  return typeof value === 'string' && INDUSTRY.test(value);
}

export function isEnterpriseSkillSort(value: unknown): value is EnterpriseSkillSort {
  return typeof value === 'string' && SORTS.has(value as EnterpriseSkillSort);
}

function normalizeIndustryTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_INDUSTRY_TAGS) {
    invalidResponse('SkillHub Enterprise response is malformed');
  }
  const tags = value.map((tag) => skillHubText(tag, { maxLength: 64, label: 'industry' }));
  if (tags.some((tag) => !isEnterpriseIndustry(tag)) || new Set(tags).size !== tags.length) {
    invalidResponse('SkillHub Enterprise response is malformed');
  }
  return tags;
}

function normalizeEnterprise(value: unknown): EnterpriseSummary {
  const item = skillHubRecord(value);
  const orgId = skillHubText(item?.orgId, { maxLength: 128, label: 'enterprise organization' });
  const name = skillHubText(item?.name, { maxLength: 512, label: 'enterprise name' });
  const publishedSkillCount = validCount(item?.publishedSkillCount);
  const totalDownloads = validCount(item?.totalDownloads, MAX_USAGE_COUNT);
  if (!item || !isSkillHubCoordinate(orgId) || !name || publishedSkillCount === null || totalDownloads === null) {
    invalidResponse('SkillHub Enterprise response is malformed');
  }
  const fullName = skillHubText(item.enterpriseFullName, { maxLength: 512, label: 'enterprise full name' });
  const shortName = skillHubText(item.enterpriseShortName, { maxLength: 512, label: 'enterprise short name' });
  const logoUrl = normalizeSkillHubHttpsUrl(item.logoUrl);
  return {
    orgId,
    name,
    ...(fullName ? { fullName } : {}),
    ...(shortName ? { shortName } : {}),
    description: skillHubSummary(item.description),
    industryTags: normalizeIndustryTags(item.industryTags),
    ...(logoUrl ? { logoUrl } : {}),
    publishedSkillCount,
    totalDownloads,
  };
}

function normalizePageMetadata(
  body: Record<string, unknown>,
  requestedPage: number,
  itemCount: number,
): { page: number; pageSize: number; total: number } {
  const page = validCount(body.page);
  const pageSize = validCount(body.pageSize);
  const total = validCount(body.total);
  if (
    page !== requestedPage
    || pageSize !== PAGE_SIZE
    || total === null
    || itemCount > PAGE_SIZE
    || itemCount > total
    || (total === 0 && page !== 1)
    || (total > 0 && page > Math.ceil(total / PAGE_SIZE))
  ) {
    invalidResponse('SkillHub Enterprise page is malformed');
  }
  return { page, pageSize, total };
}

export async function listEnterpriseIndustries(): Promise<EnterpriseIndustry[]> {
  const body = skillHubRecord(await fetchSkillHubJson('/api/v1/enterprises/industry-tags'));
  if (!body || !Array.isArray(body.items) || body.items.length > MAX_INDUSTRIES) {
    invalidResponse('SkillHub industry list is malformed');
  }
  const industries = body.items.map((value): EnterpriseIndustry => {
    const item = skillHubRecord(value);
    const key = skillHubText(item?.tagKey, { maxLength: 64, label: 'industry' });
    const displayName = skillHubText(item?.displayNameZh, { maxLength: 512, label: 'industry display name' });
    const displayNameEn = skillHubText(item?.displayNameEn, { maxLength: 512, label: 'industry display name' });
    const sortOrder = validCount(item?.sortOrder);
    if (!item || !isEnterpriseIndustry(key) || !displayName || sortOrder === null) {
      invalidResponse('SkillHub industry list is malformed');
    }
    return { key, displayName, ...(displayNameEn ? { displayNameEn } : {}), sortOrder };
  });
  if (new Set(industries.map(({ key }) => key)).size !== industries.length) {
    invalidResponse('SkillHub industry list is malformed');
  }
  return industries;
}

export async function listEnterprises(input: {
  keyword?: string;
  industry?: string;
  page?: number;
} = {}): Promise<EnterprisePage> {
  const page = normalizePage(input.page);
  const keyword = normalizeKeyword(input.keyword);
  if (input.industry !== undefined && !isEnterpriseIndustry(input.industry)) {
    throw new SkillHubProviderError('Invalid industry', 'invalid-input');
  }
  const params = new URLSearchParams({ sort: 'downloads', page: String(page), pageSize: String(PAGE_SIZE) });
  if (keyword) params.set('keyword', keyword);
  if (input.industry) params.set('industry', input.industry);
  const body = skillHubRecord(await fetchSkillHubJson(`/api/v1/enterprises?${params.toString()}`));
  if (!body || !Array.isArray(body.items) || body.items.length > PAGE_SIZE) {
    invalidResponse('SkillHub Enterprise list is malformed');
  }
  const enterprises = body.items.map(normalizeEnterprise);
  if (new Set(enterprises.map(({ orgId }) => orgId)).size !== enterprises.length) {
    invalidResponse('SkillHub Enterprise list is malformed');
  }
  return { enterprises, ...normalizePageMetadata(body, page, enterprises.length) };
}

export async function getEnterprise(orgId: string): Promise<EnterpriseDetail> {
  assertSkillHubCoordinate(orgId, 'enterprise organization');
  const body = await fetchSkillHubJson(`/api/v1/enterprises/${encodeURIComponent(orgId)}`);
  const enterprise = normalizeEnterprise(body);
  const totalStars = validCount(skillHubRecord(body)?.totalStars, MAX_USAGE_COUNT);
  if (enterprise.orgId !== orgId || totalStars === null) {
    invalidResponse('SkillHub Enterprise response is malformed');
  }
  return { ...enterprise, totalStars };
}

function normalizeEnterpriseSkill(value: unknown): EnterpriseSkillSummary | null {
  const item = skillHubRecord(value);
  const namespace = skillHubText(skillHubRecord(item?.namespace)?.handle, { maxLength: 128, label: 'namespace' });
  const slug = skillHubText(item?.slug, { maxLength: 128, label: 'Skill slug' });
  if (!item || !isSkillHubCoordinate(namespace) || !isSkillHubCoordinate(slug)) {
    return null;
  }
  const displayName = skillHubText(item?.displayName, { maxLength: 512, label: 'Skill display name' });
  const downloads = validCount(item?.downloads, MAX_USAGE_COUNT);
  const stars = validCount(item?.stars, MAX_USAGE_COUNT);
  if (!displayName || downloads === null || stars === null) {
    invalidResponse('SkillHub Enterprise Skill response is malformed');
  }
  const iconUrl = normalizeSkillHubHttpsUrl(item.iconUrl);
  return {
    namespace,
    slug,
    displayName,
    summary: skillHubSummary(item.descriptionZh) || skillHubSummary(item.description),
    downloads,
    stars,
    ...(iconUrl ? { iconUrl } : {}),
  };
}

export async function listEnterpriseSkills(
  orgId: string,
  input: { keyword?: string; sort?: EnterpriseSkillSort; page?: number } = {},
): Promise<EnterpriseSkillPage> {
  assertSkillHubCoordinate(orgId, 'enterprise organization');
  const page = normalizePage(input.page);
  const keyword = normalizeKeyword(input.keyword);
  const sort = input.sort ?? 'downloads';
  if (!isEnterpriseSkillSort(sort)) {
    throw new SkillHubProviderError('Invalid Enterprise Skill sort', 'invalid-input');
  }
  const params = new URLSearchParams({ sort, page: String(page), pageSize: String(PAGE_SIZE) });
  if (keyword) params.set('keyword', keyword);
  const body = skillHubRecord(await fetchSkillHubJson(
    `/api/v1/enterprises/${encodeURIComponent(orgId)}/skills?${params.toString()}`,
  ));
  if (!body || !Array.isArray(body.items) || body.items.length > PAGE_SIZE) {
    invalidResponse('SkillHub Enterprise Skill list is malformed');
  }
  const skills = body.items.flatMap((value) => {
    const skill = normalizeEnterpriseSkill(value);
    return skill ? [skill] : [];
  });
  if (new Set(skills.map(({ namespace, slug }) => `${namespace}/${slug}`)).size !== skills.length) {
    invalidResponse('SkillHub Enterprise Skill list is malformed');
  }
  return { skills, ...normalizePageMetadata(body, page, skills.length) };
}

export async function getEnterpriseSkill(
  orgId: string,
  namespace: string,
  slug: string,
): Promise<SkillHubSkillDetail> {
  assertSkillHubCoordinate(orgId, 'enterprise organization');
  const detail = await getSkillHubSkill(namespace, slug);
  if (detail.publisher?.orgId !== orgId) {
    throw new SkillHubProviderError('Skill is not published by this enterprise', 'not-found');
  }
  return detail;
}

export const enterpriseZoneLimits = {
  pageSize: PAGE_SIZE,
  maxIndustries: MAX_INDUSTRIES,
  maxIndustryTags: MAX_INDUSTRY_TAGS,
  maxTotal: MAX_TOTAL,
  maxPage: MAX_PAGE,
  maxQueryLength: MAX_QUERY_LENGTH,
};
