import { describe, expect, it } from 'vitest'
import type { ValidatedPromptReference } from './prompt-references'
import {
  cloneCommittedReferences,
  commitValidatedReferences,
  rebaseCommittedReferences,
  reconcileCommittedReferenceStatuses,
  restoreCommittedReferences,
  sameCommittedReferences,
} from './prompt-reference-state'

function candidate(
  input: string,
  text: string,
  status: ValidatedPromptReference['status'] = 'valid',
): ValidatedPromptReference {
  const start = input.indexOf(text)
  return {
    kind: text.startsWith('/') ? 'skill' : 'file',
    value: text.slice(1),
    start,
    end: start + text.length,
    status,
  }
}

describe('prompt reference draft state', () => {
  it('waits for a manual token boundary but commits picker selections immediately', () => {
    const incomplete = '/review'
    expect(
      commitValidatedReferences(
        incomplete,
        [],
        [candidate(incomplete, '/review')],
        { source: 'manual' },
      ),
    ).toEqual([])

    const complete = '/review '
    expect(
      commitValidatedReferences(
        complete,
        [],
        [candidate(complete, '/review')],
        { source: 'manual' },
      ),
    ).toHaveLength(1)
    expect(
      commitValidatedReferences(
        incomplete,
        [],
        [candidate(incomplete, '/review')],
        { source: 'picker' },
      ),
    ).toHaveLength(1)
  })

  it('can treat the end of input as a submit boundary', () => {
    const input = '/review'
    expect(
      commitValidatedReferences(input, [], [candidate(input, '/review')], {
        source: 'manual',
        commitAtEnd: true,
      }),
    ).toHaveLength(1)
  })

  it('keeps committed identity after confirmed invalidation', () => {
    const input = '@src/app.ts '
    const committed = commitValidatedReferences(
      input,
      [],
      [candidate(input, '@src/app.ts')],
      { source: 'paste' },
    )

    const reconciled = reconcileCommittedReferenceStatuses(committed, [
      candidate(input, '@src/app.ts', 'invalid'),
    ])

    expect(reconciled).toEqual([
      expect.objectContaining({ text: '@src/app.ts', status: 'invalid' }),
    ])
  })

  it('restores only references that currently resolve', () => {
    const input = '/review @missing.ts'
    const restored = restoreCommittedReferences(input, [
      candidate(input, '/review'),
      candidate(input, '@missing.ts', 'invalid'),
    ])

    expect(restored).toEqual([
      expect.objectContaining({ text: '/review', status: 'valid' }),
    ])
  })

  it('rebases ranges around ordinary edits and drops overlapping chips', () => {
    const input = 'a /review b'
    const committed = commitValidatedReferences(
      input,
      [],
      [candidate(input, '/review')],
      { source: 'restore' },
    )

    const shifted = rebaseCommittedReferences(input, `prefix ${input}`, committed)
    expect(shifted[0]).toEqual(
      expect.objectContaining({ start: committed[0].start + 7 }),
    )

    expect(
      rebaseCommittedReferences(input, 'a /rev b', committed),
    ).toEqual([])
  })

  it('clones snapshots without sharing entries and compares their content', () => {
    const input = '/review '
    const committed = commitValidatedReferences(
      input,
      [],
      [candidate(input, '/review')],
      { source: 'restore' },
    )
    const cloned = cloneCommittedReferences(committed)

    expect(sameCommittedReferences(committed, cloned)).toBe(true)
    expect(cloned).not.toBe(committed)
    expect(cloned[0]).not.toBe(committed[0])
  })
})
