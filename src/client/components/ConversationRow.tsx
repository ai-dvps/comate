import { memo } from 'react'

import type { DisplayMode } from '../hooks/use-app-settings'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import type { ViewItem } from '../lib/cli-meta'
import type { ResultFocusRegion } from '../lib/result-focus-view'
import { MutedSystemNote } from './ai-elements/muted-system-note'
import SlashCommandMessage from './ai-elements/slash-command-message'
import ChatMessageRenderer, { CompactBoundary, type RenderablePart } from './ChatMessageRenderer'
import { adaptChatMessage } from './chat-message-adapter'

const EMPTY_RESULT_MAP = new Map<string, Extract<RenderablePart, { type: 'tool_result' }>>()

export interface ConversationRenderRow {
  key: string
  item: ViewItem
  resultRegions?: ResultFocusRegion[]
  resultMap: Map<string, Extract<RenderablePart, { type: 'tool_result' }>>
}

interface ConversationRowProps {
  row: ConversationRenderRow
  onOpenDrawer: (parentToolUseId: string) => void
  onOpenWorkflow?: (runId: string) => void
  onOpenProcessRegion?: (messageId: string, regionIndex: number) => void
  sessionId: string
  autoApprovedTools?: Record<string, 'auto' | 'readonly'>
  searchMatches?: MessageSearchMatch[]
  currentMatch?: MessageSearchMatch | null
  displayMode: DisplayMode
}

function sameViewItem(left: ViewItem, right: ViewItem): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'message' && right.kind === 'message') return left.message === right.message
  if (left.kind === 'meta' && right.kind === 'meta') {
    return left.messageId === right.messageId && left.timestamp === right.timestamp && left.event === right.event
  }
  return left.kind === 'meta-paired' && right.kind === 'meta-paired' &&
    left.messageIds[0] === right.messageIds[0] && left.messageIds[1] === right.messageIds[1] &&
    left.timestamp === right.timestamp && left.slash === right.slash
}

function ConversationRow({
  row,
  onOpenDrawer,
  onOpenWorkflow,
  onOpenProcessRegion,
  sessionId,
  autoApprovedTools,
  searchMatches,
  currentMatch,
  displayMode,
}: ConversationRowProps) {
  const { item } = row
  if (item.kind === 'meta') {
    if (item.event.kind === 'slash-command') {
      return <SlashCommandMessage event={item.event} messageId={item.messageId} timestamp={item.timestamp} />
    }
    return <MutedSystemNote kind="single" event={item.event} timestamp={item.timestamp} />
  }
  if (item.kind === 'meta-paired') {
    return <SlashCommandMessage event={item.slash} messageId={item.messageIds[0]} timestamp={item.timestamp} />
  }

  const adapted = adaptChatMessage(item.message)
  if (adapted.role === 'system' && item.message.isCompactBoundary) {
    return <CompactBoundary />
  }
  const messageResultMap = adapted.role === 'assistant' && adapted.parts.some((part) => part.type === 'tool_use')
    ? row.resultMap
    : EMPTY_RESULT_MAP

  return (
    <ChatMessageRenderer
      message={adapted}
      resultMap={messageResultMap}
      onOpenDrawer={onOpenDrawer}
      onOpenWorkflow={onOpenWorkflow}
      sessionId={sessionId}
      autoApprovedTools={autoApprovedTools}
      searchMatches={searchMatches}
      currentMatch={currentMatch}
      displayMode={displayMode}
      onOpenProcessRegion={onOpenProcessRegion}
      resultRegions={row.resultRegions}
    />
  )
}

export default memo(ConversationRow, (previous, next) => (
  previous.row.key === next.row.key &&
  sameViewItem(previous.row.item, next.row.item) &&
  previous.row.resultRegions === next.row.resultRegions &&
  previous.row.resultMap === next.row.resultMap &&
  previous.onOpenDrawer === next.onOpenDrawer &&
  previous.onOpenWorkflow === next.onOpenWorkflow &&
  previous.onOpenProcessRegion === next.onOpenProcessRegion &&
  previous.sessionId === next.sessionId &&
  previous.autoApprovedTools === next.autoApprovedTools &&
  previous.searchMatches === next.searchMatches &&
  previous.currentMatch === next.currentMatch &&
  previous.displayMode === next.displayMode
))
