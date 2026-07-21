import { adaptChatMessage, buildResultMap, type RenderablePart } from '../components/chat-message-adapter'
import {
  groupMessageParts,
  mergeAssistantTurns,
  type MessageRegion,
  type TimestampedChatMessage,
} from '../components/message-grouping'
import type { ChatMessage } from '../types/message'

export type ResultFocusRegion = MessageRegion & { hasError?: boolean }

export interface ResultFocusTurn {
  key: string
  message: TimestampedChatMessage
  regions: ResultFocusRegion[]
}

export interface ResultFocusView {
  turns: ResultFocusTurn[]
}

export interface ResultFocusProjector {
  project(messages: ChatMessage[]): ResultFocusView
}

function isToolResultOnly(message: ChatMessage): boolean {
  return message.role === 'user' && message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'tool_result')
}

function samePart(left: RenderablePart, right: RenderablePart): boolean {
  if (left.type !== right.type) return false
  if (left.sourceMessageId !== right.sourceMessageId || left.sourcePartIndex !== right.sourcePartIndex) {
    return false
  }
  if (left.timestamp !== right.timestamp) return false

  switch (left.type) {
    case 'text':
      return right.type === 'text' && left.text === right.text
    case 'thinking':
      return right.type === 'thinking' && left.text === right.text && left.isStreaming === right.isStreaming
    case 'tool_use':
      return right.type === 'tool_use' &&
        left.toolUseId === right.toolUseId &&
        left.toolName === right.toolName &&
        left.input === right.input &&
        left.inputJsonStream === right.inputJsonStream &&
        left.isStreaming === right.isStreaming &&
        left.meta === right.meta
    case 'tool_result':
      return right.type === 'tool_result' &&
        left.toolUseId === right.toolUseId &&
        left.output === right.output &&
        left.isError === right.isError &&
        left.toolUseResult === right.toolUseResult
  }
}

function sameRegion(left: ResultFocusRegion, right: ResultFocusRegion): boolean {
  if (left.type !== right.type || left.key !== right.key || left.hasError !== right.hasError) return false
  if (left.type === 'text') {
    return right.type === 'text' &&
      left.partIndex === right.partIndex &&
      left.isFinal === right.isFinal &&
      samePart(left.part, right.part)
  }
  if (right.type !== 'process' || left.parts.length !== right.parts.length) return false
  for (let index = 0; index < left.parts.length; index += 1) {
    if (!samePart(left.parts[index], right.parts[index])) return false
  }
  return true
}

function attachResultState(
  region: MessageRegion,
  resultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>,
): ResultFocusRegion {
  if (region.type === 'text') return region
  const hasError = region.parts.some(
    (part) => part.type === 'tool_use' && resultMap.get(part.toolUseId)?.isError === true,
  )
  return { ...region, hasError }
}

export function createResultFocusProjector(): ResultFocusProjector {
  let previousTurns = new Map<string, ResultFocusTurn>()

  return {
    project(messages) {
      const seen = new Set<string>()
      const uniqueMessages = messages.filter((message) => {
        if (seen.has(message.id)) return false
        seen.add(message.id)
        return true
      })
      const resultMap = buildResultMap(uniqueMessages.map(adaptChatMessage))
      const visibleMessages = uniqueMessages.filter((message) => !isToolResultOnly(message))
      const mergedMessages = mergeAssistantTurns(visibleMessages)
      const nextTurns = new Map<string, ResultFocusTurn>()
      const turns = mergedMessages.map((message) => {
        const key = message.id.split('|')[0]
        const previous = previousTurns.get(key)
        const adapted = adaptChatMessage(message)
        const builtRegions = message.role === 'assistant'
          ? groupMessageParts(adapted.parts).map((region) => attachResultState(region, resultMap))
          : []
        const previousRegions = new Map(previous?.regions.map((region) => [region.key, region]))
        const regions = builtRegions.map((region) => {
          const candidate = previousRegions.get(region.key)
          return candidate && sameRegion(candidate, region) ? candidate : region
        })
        const unchanged = previous?.message === message &&
          previous.regions.length === regions.length &&
          previous.regions.every((region, index) => region === regions[index])
        const turn = unchanged ? previous : { key, message, regions }
        nextTurns.set(key, turn)
        return turn
      })
      previousTurns = nextTurns
      return { turns }
    },
  }
}
