import { describe, it, expect } from 'vitest'
import { groupMessageParts, mergeAssistantTurns } from './message-grouping'
import type { RenderablePart } from './chat-message-adapter'
import type { ChatMessage, MessagePart } from '../types/message'

const text = (t: string): RenderablePart => ({ type: 'text', text: t })
const think = (t = 'thinking'): RenderablePart => ({ type: 'thinking', text: t, isStreaming: false })
const tool = (name: string, id = name): RenderablePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: name,
  input: {},
  isStreaming: false,
})

const mText = (t: string): MessagePart => ({ type: 'text', text: t })
const mThink = (t = 'h'): MessagePart => ({ type: 'thinking', text: t, state: 'complete' })
const mTool = (name: string, id = name): MessagePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: name,
  input: {},
  state: 'complete',
})
const cmsg = (id: string, role: ChatMessage['role'], parts: MessagePart[]): ChatMessage => ({
  id,
  role,
  parts,
  timestamp: 1,
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

  it('process region exposes source timestamps aligned with parts', () => {
    const regions = groupMessageParts([
      { ...think(), timestamp: 1000 },
      { ...tool('Edit'), timestamp: 1000 },
      text('mid text'),
      { ...think(), timestamp: 2000 },
    ])
    expect(regions.map((r) => r.type)).toEqual(['process', 'text', 'process'])
    const proc0 = regions[0]
    if (proc0.type !== 'process') throw new Error('expected process region')
    expect(proc0.timestamps).toEqual([1000, 1000])
    const proc1 = regions[2]
    if (proc1.type !== 'process') throw new Error('expected process region')
    expect(proc1.timestamps).toEqual([2000])
  })

  it('does not fragment on empty/whitespace text between process parts', () => {
    // The store pads empty text parts when the SDK content-block index jumps;
    // these must not split one process run into multiple ghosts.
    const regions = groupMessageParts([
      { ...think(), timestamp: 1000 },
      { ...tool('Edit'), timestamp: 1000 },
      text('   '),
      { ...think(), timestamp: 2000 },
      { ...tool('Bash'), timestamp: 2000 },
      text(''),
      { ...think(), timestamp: 3000 },
    ])
    expect(regions).toHaveLength(1)
    expect(regions[0].type).toBe('process')
    const proc = regions[0]
    if (proc.type !== 'process') throw new Error('expected process region')
    expect(proc.parts).toHaveLength(5)
    expect(proc.latest.type).toBe('thinking')
    expect(proc.timestamps).toEqual([1000, 1000, 2000, 2000, 3000])
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

describe('mergeAssistantTurns', () => {
  it('merges consecutive assistant messages into one turn', () => {
    const merged = mergeAssistantTurns([
      cmsg('u1', 'user', [mText('prompt')]),
      cmsg('a1', 'assistant', [mThink(), mTool('Edit')]),
      cmsg('a2', 'assistant', [mThink(), mTool('Bash')]),
      cmsg('a3', 'assistant', [mText('done')]),
    ])
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1|a2|a3'])
    expect(merged[1].parts.map((p) => p.type)).toEqual([
      'thinking',
      'tool_use',
      'thinking',
      'tool_use',
      'text',
    ])
  })

  it('preserves per-message timestamps for merged parts', () => {
    const merged = mergeAssistantTurns([
      cmsg('u1', 'user', [mText('prompt')]),
      { id: 'a1', role: 'assistant', parts: [mThink(), mTool('Edit')], timestamp: 1000 },
      { id: 'a2', role: 'assistant', parts: [mTool('Bash')], timestamp: 2000 },
      { id: 'a3', role: 'assistant', parts: [mText('done')], timestamp: 3000 },
    ])
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1|a2|a3'])
    expect(merged[1].sourceTimestamps).toEqual([1000, 1000, 2000, 3000])
  })

  it('breaks a turn at a user prompt', () => {
    const merged = mergeAssistantTurns([
      cmsg('a1', 'assistant', [mTool('Edit')]),
      cmsg('u1', 'user', [mText('again')]),
      cmsg('a2', 'assistant', [mTool('Bash')]),
    ])
    expect(merged.map((m) => m.id)).toEqual(['a1', 'u1', 'a2'])
  })

  it('passes a single assistant message through unchanged', () => {
    const merged = mergeAssistantTurns([cmsg('a1', 'assistant', [mTool('Edit')])])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('a1')
  })
})
