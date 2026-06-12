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
import type { SearchSkill } from './types.js';

// API endpoint for skills search. Allow override via env for testing/staging.
const SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh';

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
export async function searchSkillsAPI(query: string): Promise<SearchSkill[]> {
  // Empty/whitespace query: don't call the API. Matches upstream behavior
  // (the prompt UI short-circuits on empty input; we surface the same semantic
  // to the HTTP caller so the client can render "type to search" empty state).
  if (!query || !query.trim()) {
    return [];
  }

  try {
    const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query.trim())}&limit=10`;
    const res = await fetch(url, {
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
      .map((skill) => ({
        name: sanitizeMetadata(skill.name || ''),
        slug: sanitizeMetadata(skill.id || ''),
        source: sanitizeMetadata(skill.source || ''),
        installs: typeof skill.installs === 'number' ? skill.installs : 0,
      }))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0));
  } catch {
    // Network error, JSON parse error, etc. — match upstream catch-and-return-empty.
    return [];
  }
}
