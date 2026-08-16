import {
  getPlainTextRangeForNode,
  PROMPT_REFERENCE_CHIP_ATTRIBUTE,
} from './contenteditable'

export type PromptReferenceChipKind = 'skill' | 'file'
export type PromptReferenceChipStatus = 'valid' | 'invalid'

export interface PromptReferenceChip {
  id: string
  kind: PromptReferenceChipKind
  text: string
  start: number
  end: number
  status: PromptReferenceChipStatus
}

interface ProjectPromptReferenceChipsOptions {
  invalidLabel?: (chip: PromptReferenceChip) => string
}

export interface PlainTextRange {
  start: number
  end: number
}

function isProjectableChip(
  text: string,
  chip: PromptReferenceChip,
  previousEnd: number,
): boolean {
  return (
    Number.isInteger(chip.start) &&
    Number.isInteger(chip.end) &&
    chip.start >= previousEnd &&
    chip.start >= 0 &&
    chip.end > chip.start &&
    chip.end <= text.length &&
    text.slice(chip.start, chip.end) === chip.text
  )
}

function createChipElement(
  chip: PromptReferenceChip,
  options: ProjectPromptReferenceChipsOptions,
): HTMLSpanElement {
  const element = document.createElement('span')
  element.setAttribute(PROMPT_REFERENCE_CHIP_ATTRIBUTE, 'true')
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('spellcheck', 'false')
  element.dataset.referenceId = chip.id
  element.dataset.referenceKind = chip.kind
  element.dataset.referenceText = chip.text
  element.dataset.referenceStatus = chip.status
  element.className = `prompt-reference-chip prompt-reference-chip--${chip.kind}`
  element.textContent = chip.text

  if (chip.status === 'invalid') {
    element.classList.add('prompt-reference-chip--invalid')
    element.setAttribute('aria-invalid', 'true')
    const label =
      options.invalidLabel?.(chip) ??
      `Reference no longer resolves: ${chip.text}`
    element.setAttribute('aria-label', label)
    element.title = label
  }

  return element
}

/**
 * Replace an editor's children with a plain-text-equivalent DOM projection.
 * Invalid or overlapping chip ranges are ignored instead of corrupting text.
 */
export function projectPromptReferenceChips(
  element: HTMLElement,
  text: string,
  chips: PromptReferenceChip[],
  options: ProjectPromptReferenceChipsOptions = {},
): void {
  const fragment = document.createDocumentFragment()
  let cursor = 0

  for (const chip of [...chips].sort((a, b) => a.start - b.start)) {
    if (!isProjectableChip(text, chip, cursor)) continue
    if (chip.start > cursor) {
      fragment.append(document.createTextNode(text.slice(cursor, chip.start)))
    }
    fragment.append(createChipElement(chip, options))
    cursor = chip.end
  }

  if (cursor < text.length || fragment.childNodes.length === 0) {
    fragment.append(document.createTextNode(text.slice(cursor)))
  }

  element.replaceChildren(fragment)
}

function chipRanges(element: HTMLElement): PlainTextRange[] {
  return Array.from(
    element.querySelectorAll<HTMLElement>(`[${PROMPT_REFERENCE_CHIP_ATTRIBUTE}]`),
  )
    .map((chip) => getPlainTextRangeForNode(element, chip))
    .filter((range): range is PlainTextRange => range !== null)
}

/**
 * Return the atomic plain-text range a deletion gesture should remove.
 * Ordinary text-only deletions return null and remain browser-owned.
 */
export function getPromptReferenceDeletionRange(
  element: HTMLElement,
  selectionStart: number,
  selectionEnd: number,
  direction: 'backward' | 'forward',
): PlainTextRange | null {
  let start = Math.min(selectionStart, selectionEnd)
  let end = Math.max(selectionStart, selectionEnd)
  const ranges = chipRanges(element)

  if (start === end) {
    const containing = ranges.find(
      (range) => range.start < start && start < range.end,
    )
    if (containing) return containing

    return (
      ranges.find((range) =>
        direction === 'backward'
          ? range.end === start
          : range.start === start,
      ) ?? null
    )
  }

  const touched = ranges.filter(
    (range) => start < range.end && end > range.start,
  )
  if (touched.length === 0) return null

  for (const range of touched) {
    start = Math.min(start, range.start)
    end = Math.max(end, range.end)
  }
  return { start, end }
}
