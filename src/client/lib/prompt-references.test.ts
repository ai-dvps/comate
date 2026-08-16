import { describe, expect, it } from 'vitest'
import { scanPromptReferences } from './prompt-references'

describe('scanPromptReferences', () => {
  it('finds skill and file candidates at the start or after whitespace', () => {
    expect(
      scanPromptReferences('/review then @src/app.ts\n/commit @src/app.ts'),
    ).toEqual([
      { kind: 'skill', value: 'review', start: 0, end: 7 },
      { kind: 'file', value: 'src/app.ts', start: 13, end: 24 },
      { kind: 'skill', value: 'commit', start: 25, end: 32 },
      { kind: 'file', value: 'src/app.ts', start: 33, end: 44 },
    ])
  })

  it('leaves mid-word and empty triggers unresolved', () => {
    expect(scanPromptReferences('word/review email@example.com / @')).toEqual([])
  })

  it('treats punctuation as part of the exact candidate', () => {
    expect(scanPromptReferences('/review, @src/app.ts)')).toEqual([
      { kind: 'skill', value: 'review,', start: 0, end: 8 },
      { kind: 'file', value: 'src/app.ts)', start: 9, end: 21 },
    ])
  })
})
