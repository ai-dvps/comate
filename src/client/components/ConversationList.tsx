import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowDown, Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

interface ConversationListProps {
  sessionId: string
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
  const isCompacting = useChatStore((state) => state.isCompacting[sessionId] || false)
  const follow = useConversationFollow()
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const alignToBottom = useCallback(() => {
    const element = scrollerRef.current
    if (element) element.scrollTop = element.scrollHeight
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

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (!follow.isFollowingRef.current) return
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(alignToBottom)
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [alignToBottom, follow.isFollowingRef])

  const wasVisibleRef = useRef(isVisible)
  useLayoutEffect(() => {
    if (isVisible && !wasVisibleRef.current && follow.onVisibilityRecovery() && rows.length > 0) {
      alignToBottom()
    }
    wasVisibleRef.current = isVisible
  }, [alignToBottom, follow, isVisible, rows.length])

  const previousModeRef = useRef(displayMode)
  useLayoutEffect(() => {
    if (previousModeRef.current !== displayMode) {
      previousModeRef.current = displayMode
      follow.resetForDisplayMode()
      if (rows.length > 0) alignToBottom()
    }
  }, [alignToBottom, displayMode, follow, rows.length])

  const initializedRef = useRef(false)
  useLayoutEffect(() => {
    if (!initializedRef.current && rows.length > 0) {
      initializedRef.current = true
      alignToBottom()
    }
  }, [alignToBottom, rows.length])

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
    requestAnimationFrame(() => {
      const active = scrollerRef.current?.querySelector('[data-search-active="true"]')
      if (active instanceof HTMLElement) active.scrollIntoView({ block: 'center' })
      follow.endProgrammaticScroll(token)
    })
  }, [currentMatch, follow, isVisible, projection.sourceMessageToRowKey, rows])

  const previousTailRevisionRef = useRef(projection.tailRevision)
  useLayoutEffect(() => {
    const tailChanged = projection.tailRevision !== previousTailRevisionRef.current
    previousTailRevisionRef.current = projection.tailRevision
    if (!tailChanged || !follow.isFollowingRef.current) return
    alignToBottom()
    let frame = requestAnimationFrame(() => {
      if (follow.isFollowingRef.current) alignToBottom()
      frame = requestAnimationFrame(() => {
        if (follow.isFollowingRef.current) alignToBottom()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [alignToBottom, follow.isFollowingRef, projection.tailRevision])

  const scrollToBottom = useCallback(() => {
    follow.followToBottom()
    alignToBottom()
  }, [alignToBottom, follow])

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        key={displayMode}
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="conversation-list-scroll"
        role="log"
      >
        <div ref={contentRef}>
          {rows.length === 0 ? (
            <ConversationEmptyState
              icon={<Bot className="w-8 h-8" />}
              title={t('emptyState.title')}
              description={t('emptyState.description')}
            />
          ) : rows.map((row, index) => (
            <div
              key={row.key}
              className={`mx-auto w-full max-w-3xl px-3 pb-4 ${fontSizeClass(chatFontSize)}`}
              data-item-index={index}
              data-item-key={row.key}
            >
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
          ))}
          {isCompacting && <CompactingIndicator sessionId={sessionId} />}
        </div>
      </div>
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
