/**
 * skills.sh search API wrapper.
 *
 * Reimplemented from `src/server/vendor/vercel-skills/src/find.ts:34-61`
 * because upstream `find.ts` imports `readline`, `add.ts`, `telemetry.ts`,
 * and `detect-agent.ts` at module top level — pulling any of those into
 * the sidecar bundle would drag telemetry calls in with it.
 *
 * The `searchSkillsAPI` function itself is a clean HTTP call with no
 * telemetry, so we lift it verbatim. The surrounding interactive prompt
 * machinery in `find.ts` (raw readline, ANSI cursor control, fzf-style UI)
 * is CLI-only and irrelevant to Comate's HTTP-based UI.
 */

import { sanitizeMetadata } from './sanitize.js';
import {
  normalizeSkillSearchQuery,
  toNaturalLanguageTask,
  type SkillSearchInput,
  type SkillSearchQuery,
} from './search-query.js';
import type {
  FederatedSkillSearchResult,
  SearchSkill,
  SkillProviderAvailability,
  SkillProviderFailureReason,
  SkillSearchProviderId,
} from './types.js';

// API endpoint for skills search. Allow override via env for testing/staging.
const SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh';
const SKILLS_HUB_API_BASE = process.env.SKILLS_HUB_API_URL || 'https://skillshub.wtf/api/v1';
const XFYUN_API_BASE = process.env.XFYUN_SKILLS_API_URL || 'https://skill.xfyun.cn/api/v1';
const SKILLHUB_CN_API_BASE = process.env.SKILLHUB_CN_API_URL || 'https://api.skillhub.cn';
const SEARCH_TIMEOUT_MS = 1_500;

export class SkillSearchProviderError extends Error {
  constructor(readonly reason: SkillProviderFailureReason) {
    super(`Skill search provider ${reason}`);
    this.name = 'SkillSearchProviderError';
  }
}

export interface SkillSearchProviderDescriptor {
  id: SkillSearchProviderId;
  label: string;
  search: (query: SkillSearchQuery) => Promise<SearchSkill[]>;
}

function isUsableQuery(query: string): boolean {
  return Boolean(query && query.trim());
}

function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'TimeoutError'
    : error instanceof Error && error.name === 'TimeoutError';
}

async function fetchProviderJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchWithDeadline(url, init);
  } catch (error) {
    throw new SkillSearchProviderError(isTimeoutError(error) ? 'timeout' : 'network');
  }
  if (!response.ok) throw new SkillSearchProviderError('http');
  try {
    return await response.json() as unknown;
  } catch {
    throw new SkillSearchProviderError('invalid-response');
  }
}

function invalidProviderResponse(): never {
  throw new SkillSearchProviderError('invalid-response');
}

function toSafeFailureReason(error: unknown): SkillProviderFailureReason {
  if (error instanceof SkillSearchProviderError) return error.reason;
  return isTimeoutError(error) ? 'timeout' : 'network';
}

/**
 * Search the skills.sh registry by keyword.
 *
 * Behavior matches upstream for successful and empty queries:
 *   - Empty query returns `[]` without calling fetch
 *   - Results are sorted by install count (descending)
 * Provider failures throw a safe classified error for the federation layer.
 *
 * Mirrors upstream `searchSkillsAPI(query): Promise<SearchSkill[]>`.
 */
export async function searchSkillsAPI(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  // Empty/whitespace query: don't call the API. Matches upstream behavior
  // (the prompt UI short-circuits on empty input; we surface the same semantic
  // to the HTTP caller so the client can render "type to search" empty state).
  if (!isUsableQuery(query.keyword)) {
    return [];
  }

  const task = toNaturalLanguageTask(query, 'en');
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(task)}&limit=10`;
  const data = (await fetchProviderJson(url, {
    headers: { Accept: 'application/json' },
  })) as {
    skills?: Array<{
      id: string;
      name: string;
      installs?: number;
      source?: string;
    }>;
  };

  if (!Array.isArray(data.skills)) invalidProviderResponse();

  return data.skills
    .map((skill) => {
      const slug = sanitizeMetadata(skill.id || '');
      const source = sanitizeMetadata(skill.source || '');
      const normalized: SearchSkill = {
        id: `skills.sh:${slug}`,
        name: sanitizeMetadata(skill.name || ''),
        slug,
        source,
        installSource: source,
        sourceKind: 'skills.sh' as const,
        description: '',
        installs: typeof skill.installs === 'number' ? skill.installs : 0,
      };
      return normalized;
    })
    .filter((skill) => skill.slug.length > 0 && skill.installSource.length > 0)
    .sort((a, b) => (b.installs || 0) - (a.installs || 0));
}

/**
 * Search SkillsHub's public registry.
 *
 * SkillsHub records the canonical GitHub repository for each individual
 * skill, so its results can use the existing repository resolver and local
 * installer without adopting its CLI or package format.
 */
export async function searchSkillsHubSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  const task = toNaturalLanguageTask(query, 'en');
  const url = `${SKILLS_HUB_API_BASE}/skills/resolve?task=${encodeURIComponent(task)}`;
  const data = (await fetchProviderJson(url, { headers: { Accept: 'application/json' } })) as {
    data?: Array<{ skill?: SkillsHubSkill }>;
  };
  if (!Array.isArray(data.data)) invalidProviderResponse();

  const results = data.data
    .map(({ skill }) => {
        if (!skill) return null;
        const slug = sanitizeMetadata(skill.slug || '');
        const owner = sanitizeMetadata(skill.repo?.githubOwner || '');
        const repository = sanitizeMetadata(skill.repo?.githubRepoName || '');
        const source = owner && repository ? `${owner}/${repository}` : '';
        const normalized: SearchSkill = {
          id: `skillshub:${source}:${slug}`,
          name: sanitizeMetadata(skill.name || slug),
          slug,
          source,
          installSource: source,
          sourceKind: 'skillshub' as const,
          description: sanitizeMetadata(skill.description || ''),
          installs: typeof skill.repo?.downloadCount === 'number'
            ? skill.repo.downloadCount
            : typeof skill.repo?.starCount === 'number' ? skill.repo.starCount : 0,
        };
        return normalized;
    })
    .filter((skill): skill is SearchSkill => Boolean(
      skill && skill.slug.length > 0 && skill.installSource.length > 0,
    ));
  // `/resolve` is already ranked semantically by SkillsHub. Preserve that
  // order for the unified "综合" sort; global download sorting happens in
  // `searchFederatedSkills` when explicitly requested.
  return results;
}

/** Search iFlytek Astron SkillHub's public ClawHub-compatible catalog. */
export async function searchXfyunSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  const task = toNaturalLanguageTask(query, 'zh');
  const url = `${XFYUN_API_BASE}/skills?q=${encodeURIComponent(task)}&page=0&size=10`;
  const data = (await fetchProviderJson(url, { headers: { Accept: 'application/json' } })) as {
    items?: Array<{
      slug?: string;
      displayName?: string;
      summary?: string | null;
      stats?: { downloads?: number };
    }>;
  };
  if (!Array.isArray(data.items)) invalidProviderResponse();

  return data.items
    .map((skill) => {
      const slug = sanitizeMetadata(skill.slug || '');
      return {
          id: `xfyun:${slug}`,
          name: sanitizeMetadata(skill.displayName || slug),
          slug,
          source: 'skill.xfyun.cn',
          installSource: `xfyun:${slug}`,
          sourceKind: 'xfyun' as const,
          description: sanitizeMetadata(skill.summary || ''),
          installs: typeof skill.stats?.downloads === 'number' ? skill.stats.downloads : 0,
      };
    })
    .filter((skill) => skill.slug.length > 0)
    .sort((a, b) => b.installs - a.installs);
}

/**
 * Search Tencent SkillHub's public catalog.
 *
 * SkillHub serves versioned ZIP archives itself, including community and
 * enterprise-published skills, so the installer receives a registry
 * coordinate rather than a Git repository shorthand.
 */
export async function searchSkillhubCnSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  const params = new URLSearchParams({
    page: '1',
    pageSize: '10',
    keyword: query.preferChinese ? `${query.keyword} 中文` : query.keyword,
    sortBy: query.sort || 'score',
  });
  if (query.scene) params.set('category', query.scene);
  if (query.noApiKey) params.set('labels', 'requires_api_key:false');
  const data = (await fetchProviderJson(`${SKILLHUB_CN_API_BASE}/api/skills?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  })) as {
    code?: number;
    data?: {
      skills?: Array<{
        slug?: string;
        name?: string;
        description?: string | null;
        description_zh?: string | null;
        downloads?: number;
        installs?: number;
        updated_at?: number;
        namespace?: { handle?: string };
      }>;
    };
  };
  if (data.code !== 0 || !Array.isArray(data.data?.skills)) invalidProviderResponse();

  return data.data.skills
    .map((skill) => {
        const slug = sanitizeMetadata(skill.slug || '');
        const namespace = sanitizeMetadata(skill.namespace?.handle || '');
        const coordinate = namespace && slug ? `${namespace}/${slug}` : '';
        return {
          id: `skillhub-cn:${coordinate}`,
          name: sanitizeMetadata(skill.name || slug),
          slug,
          source: 'skillhub.cn',
          installSource: `skillhub-cn:${coordinate}`,
          sourceKind: 'skillhub-cn' as const,
          description: sanitizeMetadata(skill.description_zh || skill.description || ''),
          installs: typeof skill.downloads === 'number'
            ? skill.downloads
            : typeof skill.installs === 'number' ? skill.installs : 0,
          ...(typeof skill.updated_at === 'number' ? { updatedAt: skill.updated_at } : {}),
        };
    })
    .filter((skill) => skill.slug.length > 0 && skill.installSource !== 'skillhub-cn:')
    .sort((a, b) => b.installs - a.installs);
}

export const SEARCH_PROVIDER_REGISTRY: readonly SkillSearchProviderDescriptor[] = [
  { id: 'skills.sh', label: 'skills.sh', search: searchSkillsAPI },
  { id: 'skillshub', label: 'SkillsHub', search: searchSkillsHubSkills },
  { id: 'xfyun', label: '讯飞 SkillHub', search: searchXfyunSkills },
  { id: 'skillhub-cn', label: '腾讯 SkillHub', search: searchSkillhubCnSkills },
];

export function isSkillSearchProviderId(value: string): value is SkillSearchProviderId {
  return SEARCH_PROVIDER_REGISTRY.some(({ id }) => id === value);
}

async function runProvider(
  provider: SkillSearchProviderDescriptor,
  query: SkillSearchQuery,
): Promise<{ skills: SearchSkill[]; availability: SkillProviderAvailability }> {
  try {
    return {
      skills: await provider.search(query),
      availability: { id: provider.id, label: provider.label, status: 'available' },
    };
  } catch (error) {
    return {
      skills: [],
      availability: {
        id: provider.id,
        label: provider.label,
        status: 'unavailable',
        reason: toSafeFailureReason(error),
      },
    };
  }
}

function selectedProviders(ids: SkillSearchProviderId[] | undefined): SkillSearchProviderDescriptor[] {
  if (ids === undefined) return [...SEARCH_PROVIDER_REGISTRY];
  const selected = new Set(ids);
  return SEARCH_PROVIDER_REGISTRY.filter(({ id }) => selected.has(id));
}

export async function checkSkillSearchProviders(
  ids?: SkillSearchProviderId[],
): Promise<SkillProviderAvailability[]> {
  const providers = selectedProviders(ids);
  const probeQuery: SkillSearchQuery = { keyword: 'skill', sort: 'score' };
  const results = await Promise.all(providers.map((provider) => runProvider(provider, probeQuery)));
  return results.map(({ availability }) => availability);
}

/**
 * Query the enabled registries concurrently and normalize their results.
 *
 * This is deliberately request-scoped federation: no remote catalog or
 * embedding index is written locally. A failed registry contributes no
 * results but never hides results returned by another registry.
 */
export async function searchFederatedSkills(input: SkillSearchInput): Promise<FederatedSkillSearchResult> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return { skills: [], providers: [] };

  const providers = selectedProviders(query.providers);
  const providerResults = await Promise.all(
    providers.map((provider) => runProvider(provider, query)),
  );
  const seen = new Set<string>();
  const results: SearchSkill[] = [];
  const availability: SkillProviderAvailability[] = [];

  for (const providerResult of providerResults) {
    availability.push(providerResult.availability);
    for (const result of providerResult.skills) {
      const key = `${result.sourceKind}:${result.installSource}:${result.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }

  if (query.sort === 'downloads') results.sort((a, b) => b.installs - a.installs);
  if (query.sort === 'newest') results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { skills: results, providers: availability };
}

interface SkillsHubSkill {
  slug?: string;
  name?: string;
  description?: string | null;
  repo?: {
    githubOwner?: string | null;
    githubRepoName?: string | null;
    downloadCount?: number;
    starCount?: number;
  };
}
