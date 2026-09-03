import { describe, expect, it } from 'vitest'
import type { Root } from 'hast'

import {
  rehypePromptReferenceChips,
  rehypePromptSearchHighlights,
} from './prompt-reference-markdown'

function transform(tree: Root) {
  const transformer = rehypePromptReferenceChips.call({} as never)
  if (typeof transformer !== 'function') throw new Error('Expected transformer')
  transformer(tree, {} as never, () => {})
  return tree
}

function highlight(tree: Root, ranges: Array<{ start: number; end: number; isActive: boolean }>) {
  const transformer = rehypePromptSearchHighlights.call({} as never, { ranges })
  if (typeof transformer !== 'function') throw new Error('Expected transformer')
  transformer(tree, {} as never, () => {})
  return tree
}

describe('rehypePromptReferenceChips', () => {
  it('projects prompt skills and files into the same chip shape as the composer', () => {
    const tree = transform({
      type: 'root',
      children: [{
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{ type: 'text', value: 'Run /review for @src/client/App.tsx' }],
      }],
    })

    const paragraph = tree.children[0]
    if (!paragraph || paragraph.type !== 'element') throw new Error('Expected paragraph')
    const children = paragraph.children
    const [before, skill, middle, file] = children

    expect(before).toMatchObject({ type: 'text', value: 'Run ' })
    expect(skill).toMatchObject({
      type: 'element',
      tagName: 'span',
      properties: {
        className: 'prompt-reference-chip prompt-reference-chip--skill',
        dataPromptReferenceChip: 'true',
        dataReferenceText: '/review',
        'aria-label': '/review',
      },
      children: [{ type: 'text', value: '/review' }],
    })
    expect(middle).toMatchObject({ type: 'text', value: ' for ' })
    expect(file).toMatchObject({
      type: 'element',
      tagName: 'span',
      properties: {
        className: 'prompt-reference-chip prompt-reference-chip--file',
        dataReferenceText: '@src/client/App.tsx',
        'aria-label': '@src/client/App.tsx',
      },
      children: [{ type: 'text', value: '@App.tsx' }],
    })
  })

  it('leaves code samples unchanged', () => {
    const tree = transform({
      type: 'root',
      children: [{
        type: 'element',
        tagName: 'pre',
        properties: {},
        children: [{
          type: 'element',
          tagName: 'code',
          properties: {},
          children: [{ type: 'text', value: '/review @src/client/App.tsx' }],
        }],
      }],
    })

    const pre = tree.children[0]
    if (!pre || pre.type !== 'element') throw new Error('Expected preformatted block')
    const code = pre.children[0]
    if (!code || code.type !== 'element') throw new Error('Expected code block')
    expect(code.children).toEqual([{ type: 'text', value: '/review @src/client/App.tsx' }])
  })

  it('adds search marks using source offsets while preserving Markdown structure', () => {
    const tree = {
      type: 'root' as const,
      children: [{
        type: 'element' as const,
        tagName: 'h2',
        properties: {},
        children: [{
          type: 'text' as const,
          value: 'Review',
          position: {
            start: { line: 1, column: 4, offset: 3 },
            end: { line: 1, column: 10, offset: 9 },
          },
        }],
      }],
    }

    highlight(tree, [{ start: 3, end: 9, isActive: true }])

    const heading = tree.children[0]
    if (!heading || heading.type !== 'element') throw new Error('Expected heading')
    expect(heading.tagName).toBe('h2')
    expect(heading.children).toMatchObject([{
      type: 'element',
      tagName: 'mark',
      properties: { dataSearchActive: 'true' },
      children: [{ type: 'text', value: 'Review' }],
    }])
  })

  it('preserves source positions for search matches beside a reference chip', () => {
    const tree = highlight(transform({
      type: 'root',
      children: [{
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{
          type: 'text',
          value: 'Run /review after',
          position: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 18, offset: 17 },
          },
        }],
      }],
    }), [{ start: 12, end: 17, isActive: true }])

    const paragraph = tree.children[0]
    if (!paragraph || paragraph.type !== 'element') throw new Error('Expected paragraph')
    expect(paragraph.children).toMatchObject([
      { type: 'text', value: 'Run ' },
      { type: 'element', properties: { dataPromptReferenceChip: 'true' } },
      {
        type: 'text',
        value: ' ',
      },
      {
        type: 'element',
        tagName: 'mark',
        properties: { dataSearchActive: 'true' },
        children: [{ type: 'text', value: 'after' }],
      },
    ])
  })
})
