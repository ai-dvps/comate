import { afterEach, describe, expect, it } from 'vitest'
import '../index.css'
import {
  extractPlainText,
  getCaretOffset,
  getSelectionPlainText,
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
    const invalid = element.querySelector<HTMLElement>(
      '[data-reference-status="invalid"]',
    )
    expect(invalid).not.toBeNull()
    // File chips display the basename; the model and title keep the path.
    expect(invalid!.textContent).toBe('@app.ts')
    expect(invalid!.getAttribute('aria-label')).toContain('@src/app.ts')
  })

  it('renders reference text without interpreting markup', () => {
    const text = '/<em>unsafe</em>'
    const element = editor()

    projectPromptReferenceChips(element, text, [chip(text, text, 'skill')])

    expect(element.querySelector('em')).toBeNull()
    expect(element.textContent).toBe(text)
  })

  it('aligns the chip box with the surrounding line box', () => {
    const text = 'before /review after'
    const element = editor()
    element.style.fontSize = '16px'
    element.style.lineHeight = '24px'

    projectPromptReferenceChips(element, text, [chip(text, '/review', 'skill')])

    const reference = element.querySelector<HTMLElement>(
      '[data-prompt-reference-chip]',
    )
    expect(reference).not.toBeNull()

    const style = getComputedStyle(reference!)
    expect(style.lineHeight).toBe('24px')
    expect(style.marginBlock).toBe('0px')
    expect(style.borderTopWidth).toBe('0px')
    expect(style.paddingTop).toBe('0px')
    expect(style.paddingBottom).toBe('0px')
    expect(getComputedStyle(reference!, '::before').content).toBe('none')

    // The chip is an inline-block, so its box is exactly one line tall and
    // must not inflate or shift the surrounding single-line editor.
    const chipHeight = reference!.getBoundingClientRect().height
    const editorHeight = element.getBoundingClientRect().height
    expect(Math.abs(chipHeight - 24)).toBeLessThanOrEqual(1)
    expect(Math.abs(editorHeight - 24)).toBeLessThanOrEqual(1)
  })

  it('shows file chips as basenames while the text model keeps full paths', () => {
    const reference =
      '@src/client/components/tool-renderers/a-very-long-tool-renderer-component-name.tsx'
    const text = `${reference} tail`
    const element = editor()
    element.style.fontSize = '16px'
    element.style.lineHeight = '24px'
    element.style.width = '320px'

    projectPromptReferenceChips(element, text, [
      chip(text, reference, 'file'),
    ])

    const rendered = element.querySelector<HTMLElement>(
      '[data-prompt-reference-chip]',
    )
    expect(rendered).not.toBeNull()
    // Display shows only the basename; the model and tooltip keep the path.
    expect(rendered!.textContent).toBe(
      '@a-very-long-tool-renderer-component-name.tsx',
    )
    expect(rendered!.dataset.referenceText).toBe(reference)
    expect(rendered!.getAttribute('aria-label')).toBe(reference)
    expect(extractPlainText(element)).toBe(text)

    // Copying a selection spanning the chip must yield the model text, not
    // the shortened rendered label.
    setSelectionOffsets(element, 0, text.length)
    expect(getSelectionPlainText(element)).toBe(text)

    // Pathological basenames still cap their width instead of stretching.
    const style = getComputedStyle(rendered!)
    expect(style.textOverflow).toBe('ellipsis')
    expect(style.overflowX).toBe('hidden')
    expect(rendered!.clientWidth).toBeLessThanOrEqual(320 * 0.6 + 1)
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
