import { describe, it, expect } from 'vitest'
import { filterItems } from '../lib/picker-filter'

describe('filterItems', () => {
  it('returns all items for empty query', () => {
    expect(filterItems([{ name: 'a' }, { name: 'b' }], '', 'name')).toEqual([
      { name: 'a' },
      { name: 'b' },
    ])
  })

  it('returns all items for whitespace-only query', () => {
    expect(filterItems([{ name: 'a' }, { name: 'b' }], '   ', 'name')).toEqual(
      [{ name: 'a' }, { name: 'b' }],
    )
  })

  it('matches by fuzzy subsequence', () => {
    expect(
      filterItems(
        [
          { name: 'commit' },
          { name: 'compact' },
          { name: 'help' },
        ],
        'cmt',
        'name',
      ),
    ).toEqual([{ name: 'commit' }, { name: 'compact' }])
  })

  it('preserves prefix matching as a fuzzy subset', () => {
    expect(filterItems([{ name: 'commit' }], 'comm', 'name')).toEqual([
      { name: 'commit' },
    ])
  })

  it('matches glob with * wildcard', () => {
    expect(
      filterItems(
        [{ name: 'a.ts' }, { name: 'b.tsx' }, { name: 'c.spec.ts' }],
        '*.ts',
        'name',
      ),
    ).toEqual([{ name: 'a.ts' }, { name: 'c.spec.ts' }])
  })

  it('matches glob with class pattern', () => {
    expect(
      filterItems(
        [{ name: 'a.ts' }, { name: 'b.tsx' }, { name: 'c.spec.ts' }],
        '*.spec.*',
        'name',
      ),
    ).toEqual([{ name: 'c.spec.ts' }])
  })

  it('matches glob with ? single-char wildcard', () => {
    expect(
      filterItems([{ name: 'foobar' }, { name: 'foobaz' }], 'fooba?', 'name'),
    ).toEqual([{ name: 'foobar' }, { name: 'foobaz' }])
  })

  it('returns empty array for zero glob matches', () => {
    expect(
      filterItems([{ name: 'a.ts' }, { name: 'b.tsx' }], '*.js', 'name'),
    ).toEqual([])
  })

  it('is case-insensitive in glob mode', () => {
    expect(
      filterItems([{ name: 'a.TS' }, { name: 'b.tsx' }], '*.ts', 'name'),
    ).toEqual([{ name: 'a.TS' }])
  })

  it('matches dot-files in glob mode with dot option', () => {
    expect(
      filterItems(
        [{ name: '.eslintrc.ts' }, { name: 'main.ts' }],
        '*.ts',
        'name',
      ),
    ).toEqual([{ name: '.eslintrc.ts' }, { name: 'main.ts' }])
  })

  it('filters objects by the provided key', () => {
    const items = [
      { name: 'commit', desc: 'Commit changes' },
      { name: 'compact', desc: 'Compact session' },
    ]
    expect(filterItems(items, 'cmt', 'name')).toEqual([
      { name: 'commit', desc: 'Commit changes' },
      { name: 'compact', desc: 'Compact session' },
    ])
  })
})
