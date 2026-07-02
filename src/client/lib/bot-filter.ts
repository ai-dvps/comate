import fuzzysort from 'fuzzysort';
import type { Bot } from '../stores/bot-store';

/**
 * Check whether a single bot name matches a fuzzy query.
 * Empty or whitespace-only queries always match.
 */
export function matchesBotName(bot: Pick<Bot, 'id' | 'name'>, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') return true;

  const results = fuzzysort.go(String(trimmed), [bot], {
    key: 'name',
    threshold: -10000,
  });
  return results.length > 0;
}

/**
 * Filter bots by name using fuzzy matching while preserving the original array order.
 * Empty or whitespace-only queries return the input array unchanged.
 */
export function filterBotsByName<T extends Pick<Bot, 'id' | 'name'>>(
  bots: T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (trimmed === '') return bots;

  const results = fuzzysort.go(String(trimmed), bots, {
    key: 'name',
    limit: bots.length,
    threshold: -10000,
  });
  const matchedIds = new Set(results.map((r) => r.obj.id));
  return bots.filter((bot) => matchedIds.has(bot.id));
}
