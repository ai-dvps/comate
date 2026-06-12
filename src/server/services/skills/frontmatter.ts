/**
 * Minimal YAML frontmatter parser for SKILL.md files.
 *
 * Ported from `src/server/vendor/vercel-skills/src/frontmatter.ts`.
 * Uses the `yaml` package (same as upstream). Comate adds the `yaml`
 * dependency at the repo root.
 *
 * Only supports YAML (the `---` delimiter). Does NOT support `---js` /
 * `---javascript` to avoid eval()-based RCE that exists in gray-matter's
 * built-in JS engine.
 */

import { parse as parseYaml } from 'yaml';

export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  const data = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  return { data, content: match[2] ?? '' };
}
