import { describe, it, expect } from 'vitest'
import { groupMessageParts } from './message-grouping'
import type { RenderablePart } from './chat-message-adapter'

const text = (t: string): RenderablePart => ({ type: 'text', text: t })
const think = (t = 'thinking'): RenderablePart => ({ type: 'thinking', text: t, isStreaming: false })
const tool = (name: string, id = name): RenderablePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: name,
  input: {},
  isStreaming: false,
})

describe('groupMessageParts', () => {
  it('groups interleaved parts into process regions and text (AE1, R5/R6/R7)', () => {
    const regions = groupMessageParts([
      think(),
      tool('Bash'),
      text('mid text'),
      think(),
      tool('Edit'),
      text('final answer'),
    ])

    expect(regions.map((r) => r.type)).toEqual([
      'process',
      'text',
      'process',
      'text',
    ])
    // first process region holds the first think+tool
    expect(regions[0].type === 'process' && regions[0].parts.length).toBe(2)
    // mid-turn text is NOT the final result
    expect(regions[1].type === 'text' && regions[1].isFinal).toBe(false)
    // the turn-ending text IS the final result
    expect(regions[3].type === 'text' && regions[3].isFinal).toBe(true)
  })

  it('marks only the turn-ending text as final; trailing process demotes earlier text', () => {
    // text, then more process — text does not end the turn, so not final
    const regions = groupMessageParts([text('lead'), think(), tool('Grep')])
    expect(regions.map((r) => r.type)).toEqual(['text', 'process'])
    expect(regions[0].type === 'text' && regions[0].isFinal).toBe(false)
  })

  it('a turn ending without text has no final-result block (AE2, R14)', () => {
    const regions = groupMessageParts([think(), tool('Bash')])
    expect(regions.map((r) => r.type)).toEqual(['process'])
    expect(regions.some((r) => r.type === 'text' && r.isFinal)).toBe(false)
  })

  it('a single trailing tool_use still terminates at a process region', () => {
    const regions = groupMessageParts([tool('Bash')])
    expect(regions).toHaveLength(1)
    expect(regions[0].type).toBe('process')
  })

  it('a text-only turn marks its text as final', () => {
    const regions = groupMessageParts([text('only')])
    expect(regions).toHaveLength(1)
    expect(regions[0].type).toBe('text')
    expect(regions[0].type === 'text' && regions[0].isFinal).toBe(true)
  })

  it('the last of several text parts is final when it ends the turn', () => {
    const regions = groupMessageParts([text('a'), text('b')])
    expect(regions[0].type === 'text' && regions[0].isFinal).toBe(false)
    expect(regions[1].type === 'text' && regions[1].isFinal).toBe(true)
  })

  it('a single thinking part forms a process region with no text', () => {
    const regions = groupMessageParts([think()])
    expect(regions).toHaveLength(1)
    expect(regions[0].type).toBe('process')
  })

  it('empty parts yield no regions', () => {
    expect(groupMessageParts([])).toEqual([])
  })

  it('process region exposes the latest step', () => {
    const regions = groupMessageParts([think(), tool('Edit')])
    const proc = regions[0]
    if (proc.type !== 'process') throw new Error('expected process region')
    expect(proc.latest).toBe(proc.parts[proc.parts.length - 1])
    expect(proc.latest.type).toBe('tool_use')
  })

  it('preserves streaming flags on process parts', () => {
    const streamingTool: RenderablePart = {
      type: 'tool_use',
      toolUseId: 'x',
      toolName: 'Bash',
      input: {},
      isStreaming: true,
    }
    const regions = groupMessageParts([streamingTool, text('done')])
    const proc = regions[0]
    if (proc.type !== 'process') throw new Error('expected process region')
    expect((proc.latest as { isStreaming?: boolean }).isStreaming).toBe(true)
  })
})
