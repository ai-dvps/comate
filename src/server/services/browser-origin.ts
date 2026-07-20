/**
 * browser-origin — the single "derive an origin from a URL string" helper.
 * Dependency-free so it can serve browser-audit (audit-row origins, where
 * path/query must never persist because they can carry tokens), browser-mcp
 * (handoff card payload) and browser-page-model (submit confirmation
 * payload) without pulling in their respective module chains.
 */

/** Derive the origin from a full URL; null when missing or unparseable. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
