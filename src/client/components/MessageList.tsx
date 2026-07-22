import { useEffect, useMemo, useRef } from 'react'

import { useAppSettings } from '../hooks/use-app-settings'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import { detectCliMeta, isWrapperShape, pairCliMeta, type ViewItem } from '../lib/cli-meta'
import { createConversationProjector, type ConversationRow as ProjectedRow } from '../lib/conversation-view'
import { useChatStore } from '../stores/chat-store'
import { buildResultMap } from './chat-message-adapter'
import ConversationList from './ConversationList'
import type { ConversationRenderRow } from './ConversationRow'
import type { RenderablePart } from './ChatMessageRenderer'

const EMPTY_MESSAGES: [] = []
const EMPTY_SEARCH_MATCHES: MessageSearchMatch[] = []
const warnedShapes = new Set<string>()

interface MessageListProps {
  sessionId: string
  workspaceId: string
  onOpenDrawer: (parentToolUseId: string) => void
  onOpenWorkflow?: (runId: string) => void
  onOpenProcessRegion?: (messageId: string, regionIndex: number) => void
  isVisible?: boolean
  searchMatches?: MessageSearchMatch[]
  currentMatch?: MessageSearchMatch | null
}

function viewItemKey(item: ViewItem): string {
  if (item.kind === 'message') return item.message.id.split('|')[0]
  if (item.kind === 'meta') return item.messageId
  return item.messageIds.join('-')
}

function messageForRow(row: ProjectedRow) {
  return row.kind === 'linear' ? row.message : row.turn.message
}

function sameResultMap(
  left: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>,
  right: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

export default function MessageList({
  sessionId,
  workspaceId,
  onOpenDrawer,
  onOpenWorkflow,
  onOpenProcessRegion,
  isVisible = true,
  searchMatches = EMPTY_SEARCH_MATCHES,
  currentMatch = null,
}: MessageListProps) {
  const { chatFontSize, displayMode = 'linear' } = useAppSettings()
  const messages = useChatStore((state) => state.messages[sessionId] ?? EMPTY_MESSAGES)
  const autoApprovedTools = useChatStore((state) => state.autoApprovedTools[sessionId])
  const projectorRef = useRef<ReturnType<typeof createConversationProjector>>()
  const projectorModeRef = useRef(displayMode)
  if (!projectorRef.current || projectorModeRef.current !== displayMode) {
    projectorRef.current = createConversationProjector(displayMode)
    projectorModeRef.current = displayMode
  }
  const projection = projectorRef.current.project(messages)
  const resultMap = useMemo(() => buildResultMap(messages), [messages])
  const rowResultMapsRef = useRef(new Map<string, Map<string, Extract<RenderablePart, { type: 'tool_result' }>>>())
  const rows = useMemo(() => {
    const projectedByKey = new Map(projection.rows.map((row) => [row.key, row]))
    return pairCliMeta(projection.rows.map(messageForRow)).map((item): ConversationRenderRow => {
      const key = viewItemKey(item)
      const projected = projectedByKey.get(key)
      const message = item.kind === 'message' ? item.message : null
      const nextResultMap = new Map<string, Extract<RenderablePart, { type: 'tool_result' }>>()
      if (message?.role === 'assistant') {
        for (const part of message.parts) {
          if (part.type !== 'tool_use') continue
          const result = resultMap.get(part.toolUseId)
          if (result) nextResultMap.set(part.toolUseId, result)
        }
      }
      const previousResultMap = rowResultMapsRef.current.get(key)
      const stableResultMap = previousResultMap && sameResultMap(previousResultMap, nextResultMap)
        ? previousResultMap
        : nextResultMap
      rowResultMapsRef.current.set(key, stableResultMap)
      return {
        key,
        item,
        resultRegions: projected?.kind === 'result' ? projected.turn.regions : undefined,
        resultMap: stableResultMap,
      }
    })
  }, [projection.rows, resultMap])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    for (const message of messages) {
      if (message.role !== 'user' || !message.parts.every((part) => part.type === 'text')) continue
      const text = message.parts.map((part) => part.type === 'text' ? part.text : '').join('')
      if (!isWrapperShape(text) || detectCliMeta(text) !== null || warnedShapes.has(text)) continue
      warnedShapes.add(text)
      console.warn('cli-meta: unrecognized wrapper shape', { sample: text.slice(0, 160) })
    }
  }, [messages])

  return (
    <ConversationList
      sessionId={sessionId}
      workspaceId={workspaceId}
      rows={rows}
      projection={projection}
      displayMode={displayMode}
      chatFontSize={chatFontSize}
      onOpenDrawer={onOpenDrawer}
      onOpenWorkflow={onOpenWorkflow}
      onOpenProcessRegion={onOpenProcessRegion}
      isVisible={isVisible}
      searchMatches={searchMatches}
      currentMatch={currentMatch}
      autoApprovedTools={autoApprovedTools}
    />
  )
}
