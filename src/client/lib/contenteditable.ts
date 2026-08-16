/**
 * Lightweight helpers for working with a `contentEditable` surface as if it were
 * a plain-text input.
 */

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

interface PlainTextSegment {
  node: Text
  start: number
  end: number
}

function collectPlainTextSegments(element: HTMLElement): {
  text: string
  segments: PlainTextSegment[]
} {
  let text = ''
  const segments: PlainTextSegment[] = []

  const appendText = (node: Text) => {
    const value = node.textContent ?? ''
    if (value.length === 0) return
    const start = text.length
    text += value
    segments.push({ node, start, end: text.length })
  }

  if (element.contentEditable === 'plaintext-only') {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      appendText(node as Text)
      node = walker.nextNode()
    }
    return { text, segments }
  }

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        appendText(child as Text)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue

      const tag = (child as Element).tagName
      if (tag === 'BR') {
        const parent = child.parentElement
        // The block separator below already represents <div><br></div>.
        const isEmptyBlockPlaceholder =
          parent !== null &&
          parent.childNodes.length === 1 &&
          (parent.tagName === 'DIV' || parent.tagName === 'P')
        if (!isEmptyBlockPlaceholder) text += '\n'
        continue
      }

      walk(child)
      if (tag === 'DIV' || tag === 'P') text += '\n'
    }
  }

  walk(element)
  return { text, segments }
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
  const { text, segments } = collectPlainTextSegments(element)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > text.length ||
    start >= end
  ) {
    return null
  }

  const startSegment = segments.find(
    (segment) => segment.start <= start && start < segment.end,
  )
  const endSegment = segments.find(
    (segment) => segment.start < end && end <= segment.end,
  )
  if (!startSegment || !endSegment) return null

  try {
    const range = document.createRange()
    range.setStart(startSegment.node, start - startSegment.start)
    range.setEnd(endSegment.node, end - endSegment.start)
    return range
  } catch {
    return null
  }
}

function findNodeAtOffset(
  element: HTMLElement,
  offset: number,
): [Node, number] | null {
  let remaining = offset
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) {
      return [node, remaining]
    }
    remaining -= length
    node = walker.nextNode()
  }
  return null
}

function getOffsetInElement(
  element: HTMLElement,
  container: Node,
  nodeOffset: number,
): number {
  let offset = 0
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node === container) {
      return offset + nodeOffset
    }
    offset += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  return offset
}

/**
 * Return the current caret position as a character offset within the
 * `contentEditable` element's plain-text value.
 */
export function getCaretOffset(element: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  return getOffsetInElement(element, range.startContainer, range.startOffset)
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
  const start = getOffsetInElement(element, range.startContainer, range.startOffset)
  const end = getOffsetInElement(element, range.endContainer, range.endOffset)
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
  const target = findNodeAtOffset(element, offset)
  if (target) {
    range.setStart(target[0], target[1])
    range.collapse(true)
  } else {
    range.selectNodeContents(element)
    range.collapse(false)
  }
  selection.removeAllRanges()
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

  const startTarget = findNodeAtOffset(element, start)
  const endTarget = findNodeAtOffset(element, end)
  const range = document.createRange()

  if (startTarget && endTarget) {
    range.setStart(startTarget[0], startTarget[1])
    range.setEnd(endTarget[0], endTarget[1])
  } else {
    range.selectNodeContents(element)
    range.collapse(false)
  }

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
