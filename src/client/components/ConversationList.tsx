import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso'

import type { DisplayMode } from '../hooks/use-app-settings'
import { useConversationFollow } from '../hooks/use-conversation-follow'
import type { MessageSearchMatch } from '../hooks/useMessageSearch'
import { fontSizeClass, type FontSizePreset } from '../lib/font-size'
import type { ConversationProjection } from '../lib/conversation-view'
import { useChatStore } from '../stores/chat-store'
import { ConversationEmptyState } from './ai-elements/conversation'
import { Button } from './ui/button'
import CompactingIndicator from './CompactingIndicator'
import ConversationRow, { type ConversationRenderRow } from './ConversationRow'

const FETCH_SIZE = 50
const FIRST_ITEM_INDEX = 1_000_000

interface ConversationListProps {
  sessionId: string
  workspaceId: string
  rows: ConversationRenderRow[]
  projection: ConversationProjection
  displayMode: DisplayMode
  chatFontSize: FontSizePreset
  onOpenDrawer: (parentToolUseId: string) => void
  onOpenWorkflow?: (runId: string) => void
  onOpenProcessRegion?: (messageId: string, regionIndex: number) => void
  isVisible: boolean
  searchMatches: MessageSearchMatch[]
  currentMatch: MessageSearchMatch | null
  autoApprovedTools?: Record<string, 'auto' | 'readonly'>
}

export default function ConversationList({
  sessionId,
  workspaceId,
  rows,
  projection,
  displayMode,
  chatFontSize,
  onOpenDrawer,
  onOpenWorkflow,
  onOpenProcessRegion,
  isVisible,
  searchMatches,
  currentMatch,
  autoApprovedTools,
}: ConversationListProps) {
  const { t } = useTranslation('chat')
  const totalMessageCount = useChatStore((state) => state.totalMessageCount[sessionId] || 0)
  const messageCount = useChatStore((state) => state.messages[sessionId]?.length || 0)
  const isLoadingOlder = useChatStore((state) => state.isLoadingOlderMessages[sessionId] || false)
  const isCompacting = useChatStore((state) => state.isCompacting[sessionId] || false)
  const fetchOlderMessages = useChatStore((state) => state.fetchOlderMessages)
  const follow = useConversationFollow()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX)
  const previousPrependRef = useRef(0)
  const fetchingRef = useRef(false)
  const [initialReady, setInitialReady] = useState(rows.length === 0)

  if (projection.prependedRowCount !== previousPrependRef.current) {
    firstItemIndexRef.current -= projection.prependedRowCount
    previousPrependRef.current = projection.prependedRowCount
  }

  const setScroller = useCallback((element: HTMLElement | Window | null) => {
    scrollerRef.current = element instanceof HTMLElement ? element : null
  }, [])

  useEffect(() => {
    const element = scrollerRef.current
    if (!element || !isVisible) return
    const wheel = (event: WheelEvent) => follow.onWheel(event.deltaY)
    const keydown = (event: KeyboardEvent) => follow.onKeyDown(event.key)
    const touchstart = (event: TouchEvent) => follow.onTouchStart(event.touches[0]?.clientY ?? 0)
    const touchmove = (event: TouchEvent) => follow.onTouchMove(event.touches[0]?.clientY ?? 0)
    const scroll = () => {
      const offsetBottom = element.scrollHeight - element.scrollTop - element.clientHeight
      follow.onScrollPosition(element.scrollTop, Math.abs(offsetBottom) <= 1)
    }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('keydown', keydown)
    element.addEventListener('touchstart', touchstart, { passive: true })
    element.addEventListener('touchmove', touchmove, { passive: true })
    element.addEventListener('scroll', scroll, { passive: true })
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('keydown', keydown)
      element.removeEventListener('touchstart', touchstart)
      element.removeEventListener('touchmove', touchmove)
      element.removeEventListener('scroll', scroll)
    }
  }, [follow, isVisible])

  const wasVisibleRef = useRef(isVisible)
  useLayoutEffect(() => {
    if (isVisible && !wasVisibleRef.current && follow.onVisibilityRecovery() && rows.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    }
    wasVisibleRef.current = isVisible
  }, [follow, isVisible, rows.length])

  const previousModeRef = useRef(displayMode)
  useLayoutEffect(() => {
    if (previousModeRef.current !== displayMode) {
      previousModeRef.current = displayMode
      follow.resetForDisplayMode()
      setInitialReady(rows.length === 0)
      if (rows.length > 0) virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    }
  }, [displayMode, follow, rows.length])

  const handledSearchMatchRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentMatch) {
      handledSearchMatchRef.current = null
      return
    }
    if (!isVisible) return
    const matchKey = `${currentMatch.messageId}:${currentMatch.partIndex}:${currentMatch.start}:${currentMatch.end}`
    if (handledSearchMatchRef.current === matchKey) return
    const rowKey = projection.sourceMessageToRowKey.get(currentMatch.messageId)
    const index = rows.findIndex((row) => row.key === rowKey)
    if (index < 0) return
    handledSearchMatchRef.current = matchKey
    follow.onSearchJump()
    const token = follow.beginProgrammaticScroll()
    virtuosoRef.current?.scrollToIndex({ index, align: 'center' })
    requestAnimationFrame(() => {
      const active = scrollerRef.current?.querySelector('[data-search-active="true"]')
      if (active instanceof HTMLElement) active.scrollIntoView({ block: 'center' })
      follow.endProgrammaticScroll(token)
    })
  }, [currentMatch, follow, isVisible, projection.sourceMessageToRowKey, rows])

  const previousTailRevisionRef = useRef(projection.tailRevision)
  useLayoutEffect(() => {
    if (projection.tailRevision !== previousTailRevisionRef.current && follow.isFollowingRef.current) {
      virtuosoRef.current?.autoscrollToBottom()
    }
    previousTailRevisionRef.current = projection.tailRevision
  }, [follow.isFollowingRef, projection.tailRevision])

  const handleRangeChanged = useCallback((range: ListRange) => {
    if (rows.length === 0 || range.endIndex >= firstItemIndexRef.current + rows.length - 1) {
      setInitialReady(true)
    }
  }, [rows.length])

  const handleStartReached = useCallback(() => {
    if (fetchingRef.current || isLoadingOlder || totalMessageCount <= messageCount) return
    fetchingRef.current = true
    void fetchOlderMessages(workspaceId, sessionId, FETCH_SIZE).finally(() => {
      fetchingRef.current = false
    })
  }, [fetchOlderMessages, isLoadingOlder, messageCount, sessionId, totalMessageCount, workspaceId])

  const scrollToBottom = useCallback(() => {
    follow.followToBottom()
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' })
  }, [follow])

  const Header = useCallback(() => isLoadingOlder ? (
    <div className="p-3 text-center"><span className="text-xs text-text-tertiary">{t('loading')}</span></div>
  ) : null, [isLoadingOlder, t])
  const Footer = useCallback(() => isCompacting ? <CompactingIndicator sessionId={sessionId} /> : null, [isCompacting, sessionId])
  const Empty = useCallback(() => (
    <ConversationEmptyState
      icon={<Bot className="w-8 h-8" />}
      title={t('emptyState.title')}
      description={t('emptyState.description')}
    />
  ), [t])
  const components = useMemo(() => ({
    Header,
    Footer,
    EmptyPlaceholder: Empty,
  }), [Empty, Footer, Header])

  return (
    <div className="relative flex-1 overflow-hidden" role="log">
      <Virtuoso
        key={displayMode}
        ref={virtuosoRef}
        data={rows}
        defaultItemHeight={120}
        firstItemIndex={firstItemIndexRef.current}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        computeItemKey={(_index, row) => row.key}
        scrollerRef={setScroller}
        startReached={handleStartReached}
        rangeChanged={handleRangeChanged}
        atBottomThreshold={1}
        atBottomStateChange={(atBottom) => {
          const element = scrollerRef.current
          follow.onScrollPosition(element?.scrollTop ?? 0, atBottom)
        }}
        followOutput={() => follow.isFollowingRef.current ? 'auto' : false}
        components={components}
        className={initialReady ? '' : 'opacity-0'}
        data-testid="conversation-list-scroll"
        itemContent={(_index, row) => (
          <div className={`mx-auto w-full max-w-3xl px-3 pb-4 ${fontSizeClass(chatFontSize)}`} data-item-key={row.key}>
            <ConversationRow
              row={row}
              onOpenDrawer={onOpenDrawer}
              onOpenWorkflow={onOpenWorkflow}
              onOpenProcessRegion={onOpenProcessRegion}
              sessionId={sessionId}
              autoApprovedTools={autoApprovedTools}
              searchMatches={searchMatches}
              currentMatch={currentMatch}
              displayMode={displayMode}
            />
          </div>
        )}
      />
      {!initialReady && <div className="absolute inset-0 bg-bg" aria-busy="true" />}
      {!follow.isFollowing && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg to-transparent" />}
      {!follow.isFollowing && (
        <Button
          className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full bg-bg hover:bg-surface-hover"
          onClick={scrollToBottom}
          size="icon"
          type="button"
          variant="outline"
          aria-label={t('scrollToBottom', 'Scroll to bottom')}
        >
          <ArrowDown className="size-4" />
        </Button>
      )}
    </div>
  )
}
