import { describe, expect, it } from 'vitest'

import type { ChatMessage, MessagePart } from '../types/message'
import { createConversationProjector } from './conversation-view'

function message(id: string, role: ChatMessage['role'], parts: MessagePart[]): ChatMessage {
  return { id, role, parts, timestamp: 1 }
}

const text = (value: string): MessagePart => ({ type: 'text', text: value })
const tool = (id: string): MessagePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: 'Bash',
  input: {},
  state: 'complete',
})
const result = (id: string): MessagePart => ({
  type: 'tool_result',
  toolUseId: id,
  output: 'ok',
  isError: false,
})

describe('createConversationProjector', () => {
  it('keeps unchanged Linear rows stable and reports a prepended prefix', () => {
    const projector = createConversationProjector('linear')
    const prompt = message('u2', 'user', [text('new')])
    const answer = message('a2', 'assistant', [text('answer')])
    const before = projector.project([prompt, answer])

    const after = projector.project([
      message('u1', 'user', [text('old')]),
      message('a1', 'assistant', [text('old answer')]),
      prompt,
      answer,
    ])

    expect(after.prependedRowCount).toBe(2)
    expect(after.rows.slice(2)).toEqual(before.rows)
    expect(after.rows[2]).toBe(before.rows[0])
    expect(after.sourceMessageToRowKey.get('u2')).toBe('u2')
  })

  it('keeps Result Focus turn and region identities across tail growth', () => {
    const projector = createConversationProjector('result')
    const prompt = message('u1', 'user', [text('run')])
    const first = message('a1', 'assistant', [tool('tool-1')])
    const before = projector.project([prompt, first])
    const process = before.rows[1].kind === 'result' ? before.rows[1].turn.regions[0] : null

    const after = projector.project([
      prompt,
      first,
      message('r1', 'user', [result('tool-1')]),
      message('a2', 'assistant', [text('done')]),
    ])

    expect(after.rows[0]).toBe(before.rows[0])
    expect(after.rows[1].key).toBe('a1')
    expect(after.rows[1].kind).toBe('result')
    if (after.rows[1].kind === 'result') {
      expect(after.rows[1].turn.regions[0]).toBe(process)
      expect(after.rows[1].sourceMessageIds).toEqual(['a1', 'a2'])
    }
    expect(after.sourceMessageToRowKey.get('a2')).toBe('a1')
    expect(after.tailRevision).toBeGreaterThan(before.tailRevision)
  })

  it('does not advance tailRevision for unrelated projection calls', () => {
    const projector = createConversationProjector('linear')
    const messages = [message('u1', 'user', [text('same')])]
    const before = projector.project(messages)
    const after = projector.project(messages)

    expect(after.rows[0]).toBe(before.rows[0])
    expect(after.tailRevision).toBe(before.tailRevision)
    expect(after.prependedRowCount).toBe(0)
  })
})
