import { describe, expect, it } from 'vitest'

import type { ChatMessage, MessagePart } from '../types/message'
import { createResultFocusProjector } from './result-focus-view'

const message = (
  id: string,
  role: ChatMessage['role'],
  parts: MessagePart[],
): ChatMessage => ({ id, role, parts, timestamp: 1 })

const text = (value: string): MessagePart => ({ type: 'text', text: value })
const thinking = (value: string): MessagePart => ({
  type: 'thinking',
  text: value,
  state: 'complete',
})
const tool = (id: string): MessagePart => ({
  type: 'tool_use',
  toolUseId: id,
  toolName: 'Bash',
  input: {},
  state: 'complete',
})
const result = (id: string, isError = false): MessagePart => ({
  type: 'tool_result',
  toolUseId: id,
  output: isError ? 'failed' : 'ok',
  isError,
})

describe('createResultFocusProjector', () => {
  it('keeps prior region identities when an assistant turn gains a source message', () => {
    const projector = createResultFocusProjector()
    const prompt = message('u1', 'user', [text('run it')])
    const firstStep = message('a1', 'assistant', [thinking('checking'), tool('tool-1')])

    const before = projector.project([prompt, firstStep])
    const priorTurn = before.turns[1]
    const priorProcess = priorTurn.regions[0]

    const secondStep = message('a2', 'assistant', [text('done')])
    const after = projector.project([prompt, firstStep, secondStep])

    expect(after.turns[0]).toBe(before.turns[0])
    expect(after.turns[1]).not.toBe(priorTurn)
    expect(after.turns[1].key).toBe('a1')
    expect(after.turns[1].regions[0]).toBe(priorProcess)
    expect(after.turns[1].regions.map((region) => region.key)).toEqual([
      'a1:0',
      'a2:0',
    ])
  })

  it('replaces only the process region affected by a new tool result', () => {
    const projector = createResultFocusProjector()
    const assistant = message('a1', 'assistant', [
      tool('tool-1'),
      text('middle'),
      tool('tool-2'),
    ])

    const before = projector.project([assistant])
    const firstProcess = before.turns[0].regions[0]
    const stableText = before.turns[0].regions[1]
    const secondProcess = before.turns[0].regions[2]

    const after = projector.project([
      assistant,
      message('r1', 'user', [result('tool-2', true)]),
    ])

    expect(after.turns[0].regions[0]).toBe(firstProcess)
    expect(after.turns[0].regions[1]).toBe(stableText)
    expect(after.turns[0].regions[2]).not.toBe(secondProcess)
    expect(after.turns[0].regions[2]).toMatchObject({
      key: 'a1:2',
      type: 'process',
      hasError: true,
    })
  })

  it('preserves existing turn identities when history is prepended', () => {
    const projector = createResultFocusProjector()
    const prompt = message('u2', 'user', [text('new')])
    const answer = message('a2', 'assistant', [text('answer')])
    const before = projector.project([prompt, answer])

    const after = projector.project([
      message('u1', 'user', [text('old')]),
      message('a1', 'assistant', [text('old answer')]),
      prompt,
      answer,
    ])

    expect(after.turns.slice(-2)).toEqual(before.turns)
    expect(after.turns[2]).toBe(before.turns[0])
    expect(after.turns[3]).toBe(before.turns[1])
  })

  it('ignores replayed messages with duplicate ids', () => {
    const projector = createResultFocusProjector()
    const assistant = message('a1', 'assistant', [text('answer')])
    const before = projector.project([assistant])
    const after = projector.project([assistant, assistant])

    expect(after.turns).toHaveLength(1)
    expect(after.turns[0]).toBe(before.turns[0])
  })

  it('isolates one active region across 2,000 history messages and 100 tool steps', () => {
    const projector = createResultFocusProjector()
    const history = Array.from({ length: 2_000 }, (_, index) =>
      message(
        `history-${index}`,
        'user',
        [text(`history ${index}`)],
      ),
    )
    const activeParts: MessagePart[] = []
    for (let index = 0; index < 100; index += 1) {
      activeParts.push(tool(`tool-${index}`), text(`checkpoint ${index}`))
    }
    const active = message('active', 'assistant', activeParts)
    const before = projector.project([...history, active])
    const historicalTurns = before.turns.slice(0, 2_000)
    const stableRegions = before.turns[2_000].regions.slice(0, -1)

    const nextParts = activeParts.slice()
    nextParts[nextParts.length - 1] = text('checkpoint 99 streaming delta')
    const after = projector.project([...history, { ...active, parts: nextParts }])

    for (let index = 0; index < historicalTurns.length; index += 1) {
      expect(after.turns[index]).toBe(historicalTurns[index])
    }
    for (let index = 0; index < stableRegions.length; index += 1) {
      expect(after.turns[2_000].regions[index]).toBe(stableRegions[index])
    }
    expect(after.turns[2_000].regions.at(-1)).not.toBe(before.turns[2_000].regions.at(-1))
  })
})
