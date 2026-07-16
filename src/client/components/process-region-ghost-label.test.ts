import { describe, it, expect } from 'vitest'

import { ghostLatestLabel } from './process-region-ghost-label'
import type { RenderablePart } from './chat-message-adapter'

const think = (text = 'hmm'): RenderablePart => ({ type: 'thinking', text, isStreaming: false })
const tool = (name: string, input: unknown, meta?: { displayName?: string }): RenderablePart => ({
  type: 'tool_use',
  toolUseId: name,
  toolName: name,
  input,
  isStreaming: false,
  meta,
})

describe('ghostLatestLabel', () => {
  it('signals Thinking for a thinking part', () => {
    expect(ghostLatestLabel(think())).toEqual({ kind: 'thinking' })
  })

  it('shows the tool name and command value (keep-head) for Bash', () => {
    expect(ghostLatestLabel(tool('Bash', { command: 'npm test' }))).toEqual({
      kind: 'tool',
      name: 'Bash',
      value: 'npm test',
      truncate: 'keep-head',
    })
  })

  it('classifies a file path as keep-tail so the filename survives (AE1/AE2)', () => {
    const shortPath = ghostLatestLabel(tool('Read', { file_path: 'src/client/components/ChatPanel.tsx' }))
    expect(shortPath).toMatchObject({ kind: 'tool', name: 'Read', truncate: 'keep-tail' })
    expect(shortPath.kind === 'tool' && shortPath.value).toBe('src/client/components/ChatPanel.tsx')

    const deep = ghostLatestLabel(tool('Edit', { file_path: 'src/client/components/tool-renderers/renderers/BashRenderer.tsx' }))
    expect(deep).toMatchObject({ kind: 'tool', name: 'Edit', truncate: 'keep-tail' })
    // value stays the full path; the caller (ghost) applies truncateStart
    expect(deep.kind === 'tool' && deep.value).toBe('src/client/components/tool-renderers/renderers/BashRenderer.tsx')
  })

  it('falls back to name-only for an empty input object (no Bash ▸ {}) (R2)', () => {
    expect(ghostLatestLabel(tool('Bash', {}))).toEqual({
      kind: 'tool',
      name: 'Bash',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('falls back to name-only for null/undefined input (R2)', () => {
    expect(ghostLatestLabel(tool('Bash', null))).toEqual({ kind: 'tool', name: 'Bash', value: undefined, truncate: 'keep-head' })
    expect(ghostLatestLabel(tool('Bash', undefined))).toEqual({ kind: 'tool', name: 'Bash', value: undefined, truncate: 'keep-head' })
  })

  it('falls back to name-only when the input has only unrecognized keys (R2)', () => {
    expect(ghostLatestLabel(tool('Task', { foo: 'bar' }))).toEqual({
      kind: 'tool',
      name: 'Task',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('right-truncates a URL so the domain survives (keep-head)', () => {
    const label = ghostLatestLabel(tool('WebFetch', { url: 'https://github.com/org/repo/issues/123' }))
    expect(label).toMatchObject({ kind: 'tool', name: 'WebFetch', truncate: 'keep-head' })
    expect(label.kind === 'tool' && label.value).toBe('https://github.com/org/repo/issues/123')
  })

  it('uses the description when present, even for an unknown tool name', () => {
    const label = ghostLatestLabel(tool('Task', { description: 'Run the test suite' }))
    expect(label).toEqual({ kind: 'tool', name: 'Task', value: 'Run the test suite', truncate: 'keep-head' })
  })

  it('prefers meta.displayName over toolName', () => {
    expect(ghostLatestLabel(tool('mcp__foo__bar', { command: 'x' }, { displayName: 'Foo Bar' }))).toMatchObject({
      kind: 'tool',
      name: 'Foo Bar',
      value: 'x',
    })
  })

  it('treats a short pattern/query as keep-head', () => {
    expect(ghostLatestLabel(tool('Grep', { pattern: 'focusMode' }))).toMatchObject({ kind: 'tool', name: 'Grep', truncate: 'keep-head' })
  })

  it('falls back to name-only for a non-string description (no firstKey noise)', () => {
    expect(ghostLatestLabel(tool('Task', { description: 42 }))).toEqual({
      kind: 'tool',
      name: 'Task',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('falls back to name-only for an empty/malformed questions array', () => {
    expect(ghostLatestLabel(tool('AskUserQuestion', { questions: [] }))).toEqual({
      kind: 'tool',
      name: 'AskUserQuestion',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('falls back to name-only for long content (exceeds the 120-char branch)', () => {
    expect(ghostLatestLabel(tool('Write', { content: 'x'.repeat(200) }))).toEqual({
      kind: 'tool',
      name: 'Write',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('falls back to name-only for an empty/whitespace command (no dangling separator)', () => {
    expect(ghostLatestLabel(tool('Bash', { command: '   ' }))).toEqual({
      kind: 'tool',
      name: 'Bash',
      value: undefined,
      truncate: 'keep-head',
    })
  })

  it('returns a name-only tool label for a defensive non-tool/non-thinking part', () => {
    const textPart = { type: 'text', text: 'hi' } as unknown as RenderablePart
    expect(ghostLatestLabel(textPart)).toEqual({
      kind: 'tool',
      name: 'text',
      value: undefined,
      truncate: 'keep-head',
    })
  })
})
