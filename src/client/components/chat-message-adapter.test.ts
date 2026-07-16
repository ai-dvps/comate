import { describe, it, expect } from 'vitest'
import { adaptChatMessage, buildResultMap, toToolState } from './chat-message-adapter'
import type { ChatMessage, MessagePart } from '../types/message'

const msg = (parts: MessagePart[], timestamp = 1000, sourceTimestamps?: number[]): ChatMessage & { sourceTimestamps?: number[] } => ({
  id: 'm1',
  role: 'assistant',
  parts,
  timestamp,
  sourceTimestamps,
})

const textPart = (text: string): MessagePart => ({ type: 'text', text })
const thinkingPart = (text: string, state: 'streaming' | 'complete' = 'complete'): MessagePart => ({
  type: 'thinking',
  text,
  state,
})
const toolUsePart = (
  toolName: string,
  state: 'streaming' | 'complete' = 'complete',
): MessagePart => ({
  type: 'tool_use',
  toolUseId: `tu-${toolName}`,
  toolName,
  input: {},
  state,
})
const toolResultPart = (toolUseId: string): MessagePart => ({
  type: 'tool_result',
  toolUseId,
  output: 'ok',
  isError: false,
})

describe('adaptChatMessage', () => {
  it('sets timestamp on every rendered part from msg.timestamp', () => {
    const adapted = adaptChatMessage(msg([textPart('hi'), thinkingPart('hmm'), toolUsePart('Bash')], 5000))
    expect(adapted.parts).toHaveLength(3)
    for (const part of adapted.parts) {
      expect(part.timestamp).toBe(5000)
    }
  })

  it('uses sourceTimestamps when present, falling back to msg.timestamp for missing entries', () => {
    const adapted = adaptChatMessage(
      msg(
        [textPart('a'), thinkingPart('b'), toolUsePart('C'), toolResultPart('tu-C')],
        9999,
        [1000, 3000],
      ),
    )
    expect(adapted.parts[0].timestamp).toBe(1000)
    expect(adapted.parts[1].timestamp).toBe(3000)
    expect(adapted.parts[2].timestamp).toBe(9999)
    expect(adapted.parts[3].timestamp).toBe(9999)
  })

  it('does not treat sourceTimestamp 0 as missing', () => {
    const adapted = adaptChatMessage(msg([textPart('a')], 9999, [0]))
    expect(adapted.parts[0].timestamp).toBe(0)
  })

  it('preserves existing part fields', () => {
    const adapted = adaptChatMessage(msg([textPart('hi'), thinkingPart('hmm', 'streaming'), toolUsePart('Bash', 'streaming')], 1000))
    expect(adapted.parts[0]).toMatchObject({ type: 'text', text: 'hi' })
    expect(adapted.parts[1]).toMatchObject({ type: 'thinking', text: 'hmm', isStreaming: true })
    expect(adapted.parts[2]).toMatchObject({ type: 'tool_use', toolName: 'Bash', isStreaming: true })
  })

  it('skips null/unknown parts', () => {
    const adapted = adaptChatMessage(msg([textPart('hi'), null as unknown as MessagePart], 1000))
    expect(adapted.parts).toHaveLength(1)
    expect(adapted.parts[0].timestamp).toBe(1000)
  })
})

describe('buildResultMap', () => {
  it('is unchanged by the new timestamp field', () => {
    const adapted = adaptChatMessage(msg([toolUsePart('A'), toolResultPart('tu-A')], 1000))
    const map = buildResultMap([adapted])
    expect(map.get('tu-A')).toMatchObject({ type: 'tool_result', toolUseId: 'tu-A' })
  })
})

describe('toToolState', () => {
  it('is unchanged by the new timestamp field', () => {
    const toolUse = { type: 'tool_use' as const, toolUseId: 'x', toolName: 'Bash', input: {}, isStreaming: false }
    const result = { type: 'tool_result' as const, toolUseId: 'x', output: 'ok', isError: false }
    expect(toToolState(toolUse, result)).toBe('output-available')
  })
})
