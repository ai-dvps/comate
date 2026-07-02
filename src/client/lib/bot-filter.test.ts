import { describe, it, expect } from 'vitest';
import { matchesBotName, filterBotsByName } from './bot-filter';
import type { Bot } from '../stores/bot-store';

const makeBot = (id: string, name: string): Bot =>
  ({
    id,
    name,
    activeWorkspaceId: null,
    channelSettings: {},
    rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
    createdAt: '',
    updatedAt: '',
  }) as Bot;

describe('matchesBotName', () => {
  it('matches every bot when the query is empty', () => {
    expect(matchesBotName(makeBot('1', 'Dev Helper'), '')).toBe(true);
  });

  it('matches every bot when the query is whitespace only', () => {
    expect(matchesBotName(makeBot('1', 'Dev Helper'), '   ')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesBotName(makeBot('1', 'Dev Helper'), 'dev')).toBe(true);
  });

  it('tolerates missing letters with fuzzy matching', () => {
    expect(matchesBotName(makeBot('1', 'Development Bot'), 'develpment')).toBe(true);
  });

  it('returns false when the name does not match', () => {
    expect(matchesBotName(makeBot('1', 'Sales Bot'), 'support')).toBe(false);
  });
});

describe('filterBotsByName', () => {
  const bots = [
    makeBot('1', 'Dev Helper'),
    makeBot('2', 'Sales Bot'),
    makeBot('3', 'Support Bot'),
    makeBot('4', 'Development Bot'),
  ];

  it('returns all bots for an empty query', () => {
    expect(filterBotsByName(bots, '')).toEqual(bots);
  });

  it('returns all bots for a whitespace-only query', () => {
    expect(filterBotsByName(bots, '   ')).toEqual(bots);
  });

  it('filters by case-insensitive substring', () => {
    expect(filterBotsByName(bots, 'dev')).toEqual([
      makeBot('1', 'Dev Helper'),
      makeBot('4', 'Development Bot'),
    ]);
  });

  it('filters with fuzzy typo tolerance', () => {
    expect(filterBotsByName(bots, 'develpment')).toEqual([makeBot('4', 'Development Bot')]);
  });

  it('preserves the original array order', () => {
    const reordered = [bots[3], bots[1], bots[0], bots[2]];
    expect(filterBotsByName(reordered, 'dev')).toEqual([
      makeBot('4', 'Development Bot'),
      makeBot('1', 'Dev Helper'),
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterBotsByName(bots, 'xyz')).toEqual([]);
  });
});
