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
  let data: Record<string, unknown>;
  try {
    data = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  } catch {
    // Some public registries contain otherwise valid SKILL.md documents with
    // an unquoted colon in a one-line description. Keep the fallback narrow:
    // only recover the two required scalar fields and ignore all other YAML.
    data = parseRequiredScalars(match[1]!);
  }
  return { data, content: match[2] ?? '' };
}

function parseRequiredScalars(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'description'] as const) {
    const scalar = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1]?.trim();
    if (!scalar || scalar === '|' || scalar === '>' || scalar === '|-' || scalar === '>-') continue;
    const unquoted = (
      (scalar.startsWith('"') && scalar.endsWith('"')) ||
      (scalar.startsWith("'") && scalar.endsWith("'"))
    ) ? scalar.slice(1, -1) : scalar;
    result[key] = unquoted;
  }
  return result;
}
