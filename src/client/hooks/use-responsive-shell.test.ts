import { describe, expect, it } from 'vitest'
import { deriveResponsiveShell } from './use-responsive-shell'

const base = {
  leftWidth: 288,
  rightWidth: 640,
  leftPreferredExpanded: true,
  rightPreferredExpanded: true,
  minConversationWidth: 520,
}

describe('deriveResponsiveShell', () => {
  it('keeps both preferred regions open when the full layout fits', () => {
    expect(deriveResponsiveShell({ ...base, viewportWidth: 1448 })).toEqual({
      leftExpanded: true,
      rightExpanded: true,
    })
  })

  it('collapses the right region before the Command Center', () => {
    expect(deriveResponsiveShell({ ...base, viewportWidth: 1000 })).toEqual({
      leftExpanded: true,
      rightExpanded: false,
    })
  })

  it('collapses both regions when the conversation minimum does not fit', () => {
    expect(deriveResponsiveShell({ ...base, viewportWidth: 700 })).toEqual({
      leftExpanded: false,
      rightExpanded: false,
    })
  })

  it('never reopens a region the user manually collapsed', () => {
    expect(deriveResponsiveShell({
      ...base,
      viewportWidth: 1600,
      leftPreferredExpanded: false,
      rightPreferredExpanded: false,
    })).toEqual({ leftExpanded: false, rightExpanded: false })
  })

  it('does not budget width for a manually collapsed region', () => {
    expect(deriveResponsiveShell({
      ...base,
      viewportWidth: 1160,
      leftPreferredExpanded: false,
    })).toEqual({ leftExpanded: false, rightExpanded: true })
  })

  it('allows a user to temporarily reopen an auto-collapsed region', () => {
    expect(deriveResponsiveShell({
      ...base,
      viewportWidth: 700,
      forcedExpandedSide: 'left',
    })).toEqual({ leftExpanded: true, rightExpanded: false })
  })

  it('temporarily hides the preferred right region when reopening the left region needs its space', () => {
    expect(deriveResponsiveShell({
      ...base,
      viewportWidth: 1000,
      forcedExpandedSide: 'left',
    })).toEqual({ leftExpanded: true, rightExpanded: false })
  })

  it('temporarily hides the preferred left region when reopening the right region needs its space', () => {
    expect(deriveResponsiveShell({
      ...base,
      viewportWidth: 1000,
      forcedExpandedSide: 'right',
    })).toEqual({ leftExpanded: false, rightExpanded: true })
  })
})
