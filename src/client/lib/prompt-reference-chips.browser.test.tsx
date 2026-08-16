import { afterEach, describe, expect, it } from 'vitest'
import {
  extractPlainText,
  getCaretOffset,
  setCaretOffset,
  setSelectionOffsets,
} from './contenteditable'
import {
  getPromptReferenceDeletionRange,
  projectPromptReferenceChips,
  type PromptReferenceChip,
} from './prompt-reference-chips'

function chip(
  text: string,
  value: string,
  kind: PromptReferenceChip['kind'],
  status: PromptReferenceChip['status'] = 'valid',
): PromptReferenceChip {
  const start = text.indexOf(value)
  return {
    id: `${kind}:${value}`,
    kind,
    text: value,
    start,
    end: start + value.length,
    status,
  }
}

function editor(): HTMLDivElement {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

describe('prompt reference chip projection', () => {
  it('round-trips mixed multiline text and renders references as atomic elements', () => {
    const text = 'prefix /review @src/app.ts\n中文'
    const element = editor()

    projectPromptReferenceChips(element, text, [
      chip(text, '/review', 'skill'),
      chip(text, '@src/app.ts', 'file', 'invalid'),
    ])

    expect(extractPlainText(element)).toBe(text)
    expect(element.querySelectorAll('[data-prompt-reference-chip]')).toHaveLength(2)
    expect(element.querySelector('[data-reference-status="invalid"]')).not.toBeNull()
  })

  it('renders reference text without interpreting markup', () => {
    const text = '/<em>unsafe</em>'
    const element = editor()

    projectPromptReferenceChips(element, text, [chip(text, text, 'skill')])

    expect(element.querySelector('em')).toBeNull()
    expect(element.textContent).toBe(text)
  })

  it('normalizes requested caret offsets inside a chip to its nearest edge', () => {
    const text = 'a /review b'
    const reference = chip(text, '/review', 'skill')
    const element = editor()
    projectPromptReferenceChips(element, text, [reference])

    setCaretOffset(element, reference.start + 1)
    expect(getCaretOffset(element)).toBe(reference.start)

    setCaretOffset(element, reference.end - 1)
    expect(getCaretOffset(element)).toBe(reference.end)
  })

  it('finds whole-chip deletion ranges only at the directed adjacent edge', () => {
    const text = 'a /review b'
    const reference = chip(text, '/review', 'skill')
    const element = editor()
    projectPromptReferenceChips(element, text, [reference])

    expect(
      getPromptReferenceDeletionRange(
        element,
        reference.end,
        reference.end,
        'backward',
      ),
    ).toEqual({ start: reference.start, end: reference.end })
    expect(
      getPromptReferenceDeletionRange(
        element,
        reference.start,
        reference.start,
        'forward',
      ),
    ).toEqual({ start: reference.start, end: reference.end })
    expect(
      getPromptReferenceDeletionRange(element, 0, 0, 'backward'),
    ).toBeNull()
  })

  it('expands a selection touching part of a chip and copies its plain text', () => {
    const text = 'before /review after'
    const reference = chip(text, '/review', 'skill')
    const element = editor()
    projectPromptReferenceChips(element, text, [reference])

    expect(
      getPromptReferenceDeletionRange(
        element,
        reference.start + 2,
        reference.end + 2,
        'backward',
      ),
    ).toEqual({ start: reference.start, end: reference.end + 2 })

    setSelectionOffsets(element, 0, text.length)
    expect(window.getSelection()?.toString()).toBe(text)
  })
})
