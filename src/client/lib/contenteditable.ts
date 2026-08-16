/**
 * Lightweight helpers for working with a `contentEditable` surface as if it were
 * a plain-text input.
 */

export const PROMPT_REFERENCE_CHIP_ATTRIBUTE = 'data-prompt-reference-chip'

/**
 * Detect whether the current browser supports `contentEditable="plaintext-only"`.
 */
export function supportsPlaintextOnly(): boolean {
  if (typeof document === 'undefined') return false
  const div = document.createElement('div')
  div.contentEditable = 'plaintext-only'
  return div.contentEditable === 'plaintext-only'
}

/**
 * Extract a single plain-text value from a `contentEditable` element.
 *
 * For `contentEditable="plaintext-only"`, newlines are stored literally in the
 * DOM, so `textContent` is exact and preserves intentional empty lines.
 *
 * For `contentEditable="true"`, lines are wrapped in block elements; this
 * walks the DOM and converts block separators to newlines without
 * double-counting empty blocks.
 */
export function extractPlainText(element: HTMLElement): string {
  return collectPlainTextSegments(element).text
}

/**
 * Set the text content of a `contentEditable` element. Newlines are preserved
 * visually by the `whitespace-pre-wrap` styling on the element.
 */
export function setContent(element: HTMLElement, text: string): void {
  element.textContent = text
}

interface DomPoint {
  node: Node
  offset: number
}

interface PlainTextSegment {
  kind: 'text' | 'chip' | 'newline'
  node: Node
  start: number
  end: number
  before: DomPoint
  after: DomPoint
}

function collectPlainTextSegments(element: HTMLElement): {
  text: string
  segments: PlainTextSegment[]
  nodeRanges: Map<Node, { start: number; end: number }>
} {
  let text = ''
  const segments: PlainTextSegment[] = []
  const nodeRanges = new Map<Node, { start: number; end: number }>()

  const appendText = (node: Text) => {
    const value = node.textContent ?? ''
    const start = text.length
    text += value
    nodeRanges.set(node, { start, end: text.length })
    if (value.length === 0) return
    segments.push({
      kind: 'text',
      node,
      start,
      end: text.length,
      before: { node, offset: 0 },
      after: { node, offset: value.length },
    })
  }

  if (element.contentEditable === 'plaintext-only') {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      appendText(node as Text)
      node = walker.nextNode()
    }
    nodeRanges.set(element, { start: 0, end: text.length })
    return { text, segments, nodeRanges }
  }

  const appendNewline = (before: DomPoint, after: DomPoint) => {
    const start = text.length
    text += '\n'
    segments.push({
      kind: 'newline',
      node: before.node,
      start,
      end: text.length,
      before,
      after,
    })
  }

  const walk = (node: Node) => {
    const nodeStart = text.length
    const children = Array.from(node.childNodes)
    for (const [index, child] of children.entries()) {
      if (child.nodeType === Node.TEXT_NODE) {
        appendText(child as Text)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue

      const childElement = child as HTMLElement
      if (childElement.hasAttribute(PROMPT_REFERENCE_CHIP_ATTRIBUTE)) {
        const value =
          childElement.dataset.referenceText ?? childElement.textContent ?? ''
        const start = text.length
        text += value
        const before = { node, offset: index }
        const after = { node, offset: index + 1 }
        segments.push({
          kind: 'chip',
          node: childElement,
          start,
          end: text.length,
          before,
          after,
        })
        nodeRanges.set(childElement, { start, end: text.length })
        continue
      }

      const tag = childElement.tagName
      if (tag === 'BR') {
        const parent = child.parentElement
        // The block separator below already represents <div><br></div>.
        const isEmptyBlockPlaceholder =
          parent !== null &&
          parent.childNodes.length === 1 &&
          (parent.tagName === 'DIV' || parent.tagName === 'P')
        if (!isEmptyBlockPlaceholder) {
          appendNewline(
            { node, offset: index },
            { node, offset: index + 1 },
          )
        }
        nodeRanges.set(child, { start: text.length, end: text.length })
        continue
      }

      walk(child)
      if (tag === 'DIV' || tag === 'P') {
        appendNewline(
          { node: child, offset: child.childNodes.length },
          { node, offset: index + 1 },
        )
        const range = nodeRanges.get(child)
        if (range) range.end = text.length
      }
    }
    nodeRanges.set(node, { start: nodeStart, end: text.length })
  }

  walk(element)
  return { text, segments, nodeRanges }
}

function chipAncestor(element: HTMLElement, node: Node): HTMLElement | null {
  const candidate =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const chip = candidate?.closest<HTMLElement>(
    `[${PROMPT_REFERENCE_CHIP_ATTRIBUTE}]`,
  )
  return chip && element.contains(chip) ? chip : null
}

function pointAtPlainTextOffset(element: HTMLElement, offset: number): DomPoint {
  const { text, segments } = collectPlainTextSegments(element)
  const normalized = Math.max(0, Math.min(offset, text.length))

  for (const segment of segments) {
    if (normalized < segment.start || normalized > segment.end) continue
    if (segment.kind === 'text') {
      return {
        node: segment.node,
        offset: normalized - segment.start,
      }
    }
    if (normalized === segment.start) return segment.before
    if (normalized === segment.end) return segment.after
    if (segment.kind === 'chip') {
      return normalized - segment.start < (segment.end - segment.start) / 2
        ? segment.before
        : segment.after
    }
    return segment.after
  }

  return { node: element, offset: element.childNodes.length }
}

function plainTextOffsetAtPoint(
  element: HTMLElement,
  container: Node,
  nodeOffset: number,
): number {
  const { text, nodeRanges } = collectPlainTextSegments(element)
  const chip = chipAncestor(element, container)
  if (chip) {
    const range = nodeRanges.get(chip)
    if (!range) return text.length
    if (container === chip) {
      return nodeOffset === 0 ? range.start : range.end
    }
    const chipTextLength = chip.textContent?.length ?? 0
    return nodeOffset < chipTextLength / 2 ? range.start : range.end
  }

  if (container.nodeType === Node.TEXT_NODE) {
    const range = nodeRanges.get(container)
    return range
      ? Math.max(range.start, Math.min(range.start + nodeOffset, range.end))
      : text.length
  }

  const children = Array.from(container.childNodes)
  if (nodeOffset <= 0) return nodeRanges.get(container)?.start ?? 0
  const previous = children[Math.min(nodeOffset, children.length) - 1]
  return previous
    ? (nodeRanges.get(previous)?.end ?? text.length)
    : (nodeRanges.get(container)?.end ?? text.length)
}

export function getPlainTextRangeForNode(
  element: HTMLElement,
  node: Node,
): { start: number; end: number } | null {
  const range = collectPlainTextSegments(element).nodeRanges.get(node)
  return range ? { ...range } : null
}

/**
 * Create a DOM range for offsets measured against `extractPlainText`.
 * Synthetic newlines created by fallback block markup intentionally do not
 * produce ranges, because they have no DOM text node to highlight.
 */
export function createRangeFromPlainTextOffsets(
  element: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const { text } = collectPlainTextSegments(element)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > text.length ||
    start >= end
  ) {
    return null
  }

  try {
    const range = document.createRange()
    const startPoint = pointAtPlainTextOffset(element, start)
    const endPoint = pointAtPlainTextOffset(element, end)
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  } catch {
    return null
  }
}

/**
 * Return the current caret position as a character offset within the
 * `contentEditable` element's plain-text value.
 */
export function getCaretOffset(element: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  return plainTextOffsetAtPoint(
    element,
    range.startContainer,
    range.startOffset,
  )
}

/**
 * Return the start and end character offsets of the current selection within
 * the `contentEditable` element's plain-text value. When the selection is
 * collapsed, both values are equal.
 */
export function getSelectionOffsets(element: HTMLElement): [number, number] {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return [0, 0]
  }
  const range = selection.getRangeAt(0)
  const start = plainTextOffsetAtPoint(
    element,
    range.startContainer,
    range.startOffset,
  )
  const end = plainTextOffsetAtPoint(
    element,
    range.endContainer,
    range.endOffset,
  )
  return [start, end]
}

/**
 * Place the caret at a specific character offset within the `contentEditable`
 * element. If the offset is out of range, the caret is placed at the end.
 */
export function setCaretOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection()
  if (!selection) return

  const range = document.createRange()
  const target = pointAtPlainTextOffset(element, offset)
  range.setStart(target.node, target.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function setSelectionOffsets(
  element: HTMLElement,
  anchorOffset: number,
  focusOffset: number,
): void {
  const selection = window.getSelection()
  if (!selection) return
  const anchor = pointAtPlainTextOffset(element, anchorOffset)
  const focus = pointAtPlainTextOffset(element, focusOffset)

  selection.removeAllRanges()
  if (typeof selection.setBaseAndExtent === 'function') {
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset,
    )
    return
  }

  const range = document.createRange()
  if (anchorOffset <= focusOffset) {
    range.setStart(anchor.node, anchor.offset)
    range.setEnd(focus.node, focus.offset)
  } else {
    range.setStart(focus.node, focus.offset)
    range.setEnd(anchor.node, anchor.offset)
  }
  selection.addRange(range)
}

/**
 * Replace the text between `start` and `end` offsets with `text`, then place
 * the caret at the end of the inserted text.
 */
export function replaceText(
  element: HTMLElement,
  text: string,
  start: number,
  end: number,
): void {
  element.focus()
  const selection = window.getSelection()
  if (!selection) return

  const startTarget = pointAtPlainTextOffset(element, start)
  const endTarget = pointAtPlainTextOffset(element, end)
  const range = document.createRange()

  range.setStart(startTarget.node, startTarget.offset)
  range.setEnd(endTarget.node, endTarget.offset)

  selection.removeAllRanges()
  selection.addRange(range)
  range.deleteContents()

  const inserted = document.createTextNode(text)
  range.insertNode(inserted)
  range.setStartAfter(inserted)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Insert `text` at the given offset, or at the current caret position when no
 * offset is supplied. The caret is moved to the end of the inserted text.
 */
export function insertTextAtOffset(
  element: HTMLElement,
  text: string,
  offset?: number,
): void {
  if (offset !== undefined) {
    replaceText(element, text, offset, offset)
  } else {
    replaceText(element, text, getCaretOffset(element), getCaretOffset(element))
  }
}
