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
import type { SearchSkill } from './types.js';
import { createWeSkillHubClient, type WeSkillHubSearchSort } from './weskillhub.js';

// API endpoint for skills search. Allow override via env for testing/staging.
const SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh';
const SKILLS_HUB_API_BASE = process.env.SKILLS_HUB_API_URL || 'https://skillshub.wtf/api/v1';
const XFYUN_API_BASE = process.env.XFYUN_SKILLS_API_URL || 'https://skill.xfyun.cn/api/v1';
const SKILLHUB_CN_API_BASE = process.env.SKILLHUB_CN_API_URL || 'https://api.skillhub.cn';
const SEARCH_TIMEOUT_MS = 1_500;

type SearchProvider = (query: SkillSearchQuery) => Promise<SearchSkill[]>;

function isUsableQuery(query: string): boolean {
  return Boolean(query && query.trim());
}

function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
}

/**
 * Search the skills.sh registry by keyword.
 *
 * Behavior matches upstream:
 *   - Empty query returns `[]` without calling fetch
 *   - Non-2xx response returns `[]`
 *   - Network error returns `[]` (catch-and-return-empty semantics)
 *   - Results are sorted by install count (descending)
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

  try {
    const task = toNaturalLanguageTask(query, 'en');
    const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(task)}&limit=10`;
    const res = await fetchWithDeadline(url, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      skills?: Array<{
        id: string;
        name: string;
        installs?: number;
        source?: string;
      }>;
    };

    if (!data.skills || !Array.isArray(data.skills)) return [];

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
  } catch {
    // Network error, JSON parse error, etc. — match upstream catch-and-return-empty.
    return [];
  }
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

  try {
    const task = toNaturalLanguageTask(query, 'en');
    const url = `${SKILLS_HUB_API_BASE}/skills/resolve?task=${encodeURIComponent(task)}`;
    const res = await fetchWithDeadline(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data?: Array<{ skill?: SkillsHubSkill }>;
    };
    if (!Array.isArray(data.data)) return [];

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
      .filter((skill): skill is SearchSkill => Boolean(skill && skill.slug.length > 0 && skill.installSource.length > 0));
    // `/resolve` is already ranked semantically by SkillsHub. Preserve that
    // order for the unified "综合" sort; global download sorting happens in
    // `searchFederatedSkills` when explicitly requested.
    return results;
  } catch {
    return [];
  }
}

/** Search iFlytek Astron SkillHub's public ClawHub-compatible catalog. */
export async function searchXfyunSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  try {
    const task = toNaturalLanguageTask(query, 'zh');
    const url = `${XFYUN_API_BASE}/skills?q=${encodeURIComponent(task)}&page=0&size=10`;
    const res = await fetchWithDeadline(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      items?: Array<{
        slug?: string;
        displayName?: string;
        summary?: string | null;
        stats?: { downloads?: number };
      }>;
    };
    if (!Array.isArray(data.items)) return [];

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
  } catch {
    return [];
  }
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

  try {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '10',
      keyword: query.preferChinese ? `${query.keyword} 中文` : query.keyword,
      sortBy: query.sort || 'score',
    });
    if (query.scene) params.set('category', query.scene);
    if (query.noApiKey) params.set('labels', 'requires_api_key:false');
    const res = await fetchWithDeadline(`${SKILLHUB_CN_API_BASE}/api/skills?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
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
    if (data.code !== 0 || !Array.isArray(data.data?.skills)) return [];

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
  } catch {
    return [];
  }
}

/** Search WeSkillHub's public catalog through its bounded provider client. */
export async function searchWeSkillHubSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  const sortMap: Record<NonNullable<SkillSearchQuery['sort']>, WeSkillHubSearchSort> = {
    score: 'hot',
    downloads: 'downloads',
    newest: 'update_date',
  };

  try {
    const records = await createWeSkillHubClient().searchSkills({
      search: query.keyword,
      sort: sortMap[query.sort || 'score'],
    });
    return records.map((skill) => {
      const coordinate = `${skill.id}/${skill.slug}`;
      return {
        id: `weskillhub:${coordinate}`,
        name: skill.name,
        slug: skill.slug,
        source: 'weskillhub.weoa.com',
        installSource: `weskillhub:${coordinate}`,
        sourceKind: 'weskillhub' as const,
        description: skill.description,
        installs: skill.downloads,
        ...(skill.updatedAt !== undefined ? { updatedAt: skill.updatedAt } : {}),
      };
    });
  } catch {
    return [];
  }
}

const searchProviders: SearchProvider[] = [
  searchSkillsAPI,
  searchSkillsHubSkills,
  searchXfyunSkills,
  searchSkillhubCnSkills,
  searchWeSkillHubSkills,
];

/**
 * Query the enabled registries concurrently and normalize their results.
 *
 * This is deliberately request-scoped federation: no remote catalog or
 * embedding index is written locally. A failed registry contributes no
 * results but never hides results returned by another registry.
 */
export async function searchFederatedSkills(input: SkillSearchInput): Promise<SearchSkill[]> {
  const query = normalizeSkillSearchQuery(input);
  if (!isUsableQuery(query.keyword)) return [];

  const providerResults = await Promise.allSettled(searchProviders.map((search) => search(query)));
  const seen = new Set<string>();
  const results: SearchSkill[] = [];

  for (const providerResult of providerResults) {
    if (providerResult.status !== 'fulfilled') continue;
    for (const result of providerResult.value) {
      const key = `${result.sourceKind}:${result.installSource}:${result.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }

  if (query.sort === 'downloads') return results.sort((a, b) => b.installs - a.installs);
  if (query.sort === 'newest') return results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return results;
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
