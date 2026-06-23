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
 * Walk the children of a node and build a plain-text string. Block-level
 * elements (`<div>`, `<p>`) and `<br>` are converted to newline characters.
 */
function walkTextNodes(node: Node): string {
  let result = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent ?? ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName
      if (tag === 'BR') {
        result += '\n'
      } else {
        result += walkTextNodes(child)
        if (tag === 'DIV' || tag === 'P') {
          result += '\n'
        }
      }
    }
  }
  return result
}

/**
 * Extract a single plain-text value from a `contentEditable` element,
 * normalizing consecutive block separators to single newline characters.
 */
export function extractPlainText(element: HTMLElement): string {
  const raw = walkTextNodes(element)
  return raw.replace(/\n+/g, '\n')
}

/**
 * Set the text content of a `contentEditable` element. Newlines are preserved
 * visually by the `whitespace-pre-wrap` styling on the element.
 */
export function setContent(element: HTMLElement, text: string): void {
  element.textContent = text
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
