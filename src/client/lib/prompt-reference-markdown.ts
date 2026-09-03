import type { Element, Root, RootContent, Text } from 'hast'
import type { Plugin } from 'unified'

import type { SearchHighlightRange } from '../hooks/useMessageSearch'
import { cn } from '../components/ui/utils'
import { fileChipDisplayLabel } from './prompt-reference-chips'
import { scanPromptReferences } from './prompt-references'

const REFERENCE_EXCLUDED_TAGS = new Set(['a', 'code', 'kbd', 'pre', 'samp'])
const HIGHLIGHT_EXCLUDED_TAGS = new Set(['code', 'kbd', 'pre', 'samp'])

function createReferenceChip(
  reference: ReturnType<typeof scanPromptReferences>[number],
  sourceOffset: number | undefined,
): Element {
  const text = reference.kind === 'skill'
    ? `/${reference.value}`
    : `@${reference.value}`

  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: cn(
        'prompt-reference-chip',
        `prompt-reference-chip--${reference.kind}`,
      ),
      dataPromptReferenceChip: 'true',
      dataReferenceKind: reference.kind,
      dataReferenceText: text,
      dataReferenceStatus: 'valid',
      dataReferenceStart: sourceOffset === undefined ? undefined : sourceOffset + reference.start,
      dataReferenceEnd: sourceOffset === undefined ? undefined : sourceOffset + reference.end,
      'aria-label': text,
      title: text,
    },
    children: [{
      type: 'text',
      value: reference.kind === 'file' ? fileChipDisplayLabel(text) : text,
    }],
  }
}

function projectTextReferences(text: Text): RootContent[] {
  const references = scanPromptReferences(text.value)
  if (references.length === 0) return [text]

  const children: RootContent[] = []
  let cursor = 0
  for (const reference of references) {
    if (reference.start > cursor) {
      children.push({ type: 'text', value: text.value.slice(cursor, reference.start) })
    }
    children.push(createReferenceChip(reference, text.position?.start.offset))
    cursor = reference.end
  }
  if (cursor < text.value.length) {
    children.push({ type: 'text', value: text.value.slice(cursor) })
  }
  return children
}

function projectReferencesInChildren(
  parent: Root | Element,
  referencesExcluded = false,
): void {
  if (referencesExcluded) return
  const nextChildren: RootContent[] = []
  for (const child of parent.children) {
    if (child.type === 'text') {
      nextChildren.push(...projectTextReferences(child))
      continue
    }
    if (child.type === 'element') {
      projectReferencesInChildren(
        child,
        REFERENCE_EXCLUDED_TAGS.has(child.tagName),
      )
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren
}

function createSearchHighlight(
  value: string,
  isActive: boolean,
): Element {
  return {
    type: 'element',
    tagName: 'mark',
    properties: isActive
      ? {
          className: cn('rounded', 'bg-accent/70', 'px-0.5', 'text-text-primary', 'ring-1', 'ring-accent'),
          dataSearchActive: 'true',
        }
      : {
          className: cn('rounded', 'bg-accent/40', 'px-0.5', 'text-text-primary'),
          dataSearchMatch: 'true',
        },
    children: [{ type: 'text', value }],
  }
}

function projectTextHighlights(
  text: Text,
  ranges: readonly SearchHighlightRange[],
): RootContent[] {
  const startOffset = text.position?.start.offset
  const endOffset = text.position?.end.offset
  if (startOffset === undefined || endOffset === undefined) return [text]

  const matches = ranges
    .filter((range) => range.start < endOffset && range.end > startOffset)
    .map((range) => ({
      start: Math.max(range.start, startOffset) - startOffset,
      end: Math.min(range.end, endOffset) - startOffset,
      isActive: range.isActive,
    }))
    .filter((range) => range.start < range.end && range.end <= text.value.length)
  if (matches.length === 0) return [text]

  const children: RootContent[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) {
      children.push({ type: 'text', value: text.value.slice(cursor, match.start) })
    }
    children.push(createSearchHighlight(text.value.slice(match.start, match.end), match.isActive))
    cursor = match.end
  }
  if (cursor < text.value.length) {
    children.push({ type: 'text', value: text.value.slice(cursor) })
  }
  return children
}

function projectSearchHighlightsInChildren(
  parent: Root | Element,
  ranges: readonly SearchHighlightRange[],
  highlightsExcluded = false,
): void {
  if (highlightsExcluded) return
  const nextChildren: RootContent[] = []
  for (const child of parent.children) {
    if (child.type === 'text') {
      nextChildren.push(...projectTextHighlights(child, ranges))
      continue
    }
    if (child.type === 'element') {
      const start = child.properties.dataReferenceStart
      const end = child.properties.dataReferenceEnd
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        ranges.some((range) => range.start < end && range.end > start)
      ) {
        const isActive = ranges.some((range) =>
          range.isActive && range.start < end && range.end > start,
        )
        child.properties.className = cn(
          child.properties.className,
          'rounded',
          isActive ? 'bg-accent/70' : 'bg-accent/40',
          'px-0.5',
          'text-text-primary',
          ...(isActive ? ['ring-1', 'ring-accent'] : []),
        )
        child.properties[isActive ? 'dataSearchActive' : 'dataSearchMatch'] = 'true'
        nextChildren.push(child)
        continue
      }
      projectSearchHighlightsInChildren(
        child,
        ranges,
        HIGHLIGHT_EXCLUDED_TAGS.has(child.tagName),
      )
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren
}

/**
 * Render prompt references as chips after Markdown has been parsed. Keeping
 * this as a rehype transform lets Markdown retain its normal block and inline
 * structure while matching the composer’s reference presentation.
 */
export const rehypePromptReferenceChips: Plugin = () => {
  return (tree): void => {
    projectReferencesInChildren(tree as Root)
  }
}

/** Render search ranges without falling back from Markdown to source text. */
export const rehypePromptSearchHighlights: Plugin<[options: {
  ranges: readonly SearchHighlightRange[]
}]> = (options) => {
  return (tree): void => {
    projectSearchHighlightsInChildren(tree as Root, options.ranges)
  }
}
