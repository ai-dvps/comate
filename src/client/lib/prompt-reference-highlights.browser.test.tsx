import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPromptReferenceHighlights,
  PROMPT_FILE_HIGHLIGHT_NAME,
  PROMPT_SKILL_HIGHLIGHT_NAME,
  setPromptReferenceHighlights,
} from './prompt-reference-highlights'

function textRange(text: Text): Range {
  const range = document.createRange()
  range.selectNodeContents(text)
  return range
}

afterEach(() => {
  CSS.highlights.clear()
  document.body.replaceChildren()
})

describe('prompt reference highlight registry', () => {
  it('aggregates ranges from multiple owners and cleans up independently', () => {
    const first = document.createTextNode('/review')
    const second = document.createTextNode('@src/app.ts')
    document.body.append(first, second)
    const firstOwner = Symbol('first')
    const secondOwner = Symbol('second')

    setPromptReferenceHighlights(firstOwner, {
      skill: [textRange(first)],
      file: [],
    })
    setPromptReferenceHighlights(secondOwner, {
      skill: [],
      file: [textRange(second)],
    })

    expect(CSS.highlights.get(PROMPT_SKILL_HIGHLIGHT_NAME)?.size).toBe(1)
    expect(CSS.highlights.get(PROMPT_FILE_HIGHLIGHT_NAME)?.size).toBe(1)

    clearPromptReferenceHighlights(firstOwner)
    expect(CSS.highlights.has(PROMPT_SKILL_HIGHLIGHT_NAME)).toBe(false)
    expect(CSS.highlights.get(PROMPT_FILE_HIGHLIGHT_NAME)?.size).toBe(1)

    clearPromptReferenceHighlights(secondOwner)
    expect(CSS.highlights.has(PROMPT_FILE_HIGHLIGHT_NAME)).toBe(false)
  })
})
