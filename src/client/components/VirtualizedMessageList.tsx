import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Bot } from 'lucide-react'

import { useAppSettings } from '../hooks/use-app-settings'
import { fontSizeClass } from '../lib/font-size'
import { useChatStore } from '../stores/chat-store'
import {
  detectCliMeta,
  isWrapperShape,
  pairCliMeta,
  type ViewItem,
} from '../lib/cli-meta'
import type { ChatMessage } from '../types/message'

import { ConversationEmptyState } from './ai-elements/conversation'
import { MutedSystemNote } from './ai-elements/muted-system-note'
import SlashCommandMessage from './ai-elements/slash-command-message'
import { Button } from './ui/button'
import CompactingIndicator from './CompactingIndicator'
import ChatMessageRenderer, {
  adaptChatMessage,
  buildResultMap,
  CompactBoundary,
} from './ChatMessageRenderer'

const EMPTY_ARRAY: [] = []

interface VirtualizedMessageListProps {
  sessionId: string
  workspaceId: string
  onOpenDrawer: (parentToolUseId: string) => void
  isVisible?: boolean
}

const warnedShapes = new Set<string>()
const SCROLL_BOTTOM_THRESHOLD = 50
const OVERSCAN_COUNT = 5
const GAP_SIZE = 16 // gap-4 = 1rem = 16px

function getViewItemKey(item: ViewItem): string {
  if (item.kind === 'message') return item.message.id
  if (item.kind === 'meta') return item.messageId
  return item.messageIds.join('-')
}

function isToolResultOnly(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.parts.length > 0 &&
    msg.parts.every((p) => p?.type === 'tool_result')
  )
}

const FETCH_SIZE = 50
const SCROLL_TOP_TRIGGER_THRESHOLD = 500

export default function VirtualizedMessageList({
  sessionId,
  workspaceId,
  onOpenDrawer,
  isVisible = true,
}: VirtualizedMessageListProps) {
  const { t } = useTranslation('chat')
  const { chatFontSize } = useAppSettings()
  const messages = useChatStore((s) => s.messages[sessionId] ?? EMPTY_ARRAY)
  const totalMessageCount = useChatStore((s) => s.totalMessageCount[sessionId] || 0)
  const isLoadingOlder = useChatStore((s) => s.isLoadingOlderMessages[sessionId] || false)
  const isCompacting = useChatStore((s) => s.isCompacting[sessionId] || false)
  const autoApprovedTools = useChatStore((s) => s.autoApprovedTools[sessionId])
  const fetchOlderMessages = useChatStore((s) => s.fetchOlderMessages)
  const parentRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const prevMessageCount = useRef(messages.length)
  const isFetchingRef = useRef(false)

  const resultMap = useMemo(() => buildResultMap(messages), [messages])
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isToolResultOnly(m)),
    [messages],
  )
  const viewItems = useMemo(() => pairCliMeta(visibleMessages), [visibleMessages])

  const virtualizer = useVirtualizer({
    count: viewItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: OVERSCAN_COUNT,
    gap: GAP_SIZE,
    getItemKey: (index) => {
      const item = viewItems[index]
      return item ? getViewItemKey(item) : String(index)
    },
  })

  const virtualItems = virtualizer.getVirtualItems()
  const prevViewItemsRef = useRef(viewItems)
  const anchorKeyRef = useRef<string | null>(null)

  // Remeasure virtualizer when transitioning from hidden to visible
  const wasVisibleRef = useRef(isVisible)
  useEffect(() => {
    if (isVisible && !wasVisibleRef.current) {
      requestAnimationFrame(() => {
        virtualizer.measure()
      })
    }
    wasVisibleRef.current = isVisible
  }, [isVisible, virtualizer])

  // Detect prepend and anchor scroll position
  useEffect(() => {
    const prev = prevViewItemsRef.current
    const prevLen = prev.length
    const currLen = viewItems.length

    if (currLen > prevLen && anchorKeyRef.current !== null) {
      // Check if tail matches (indicates prepend)
      let tailMatches = true
      for (let i = 0; i < prevLen; i++) {
        if (getViewItemKey(prev[i]) !== getViewItemKey(viewItems[currLen - prevLen + i])) {
          tailMatches = false
          break
        }
      }

      if (tailMatches) {
        const newIndex = viewItems.findIndex(
          (item) => getViewItemKey(item) === anchorKeyRef.current,
        )
        if (newIndex >= 0) {
          requestAnimationFrame(() => {
            virtualizer.scrollToIndex(newIndex, { align: 'start' })
          })
        }
      }
    }

    prevViewItemsRef.current = viewItems
  }, [viewItems, virtualizer])

  // Capture first visible key before each render for potential anchoring
  useEffect(() => {
    const items = virtualizer.getVirtualItems()
    if (items.length > 0) {
      anchorKeyRef.current = String(items[0].key)
    }
  })

  // Detect scroll position for auto-scroll and scroll-to-bottom button
  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    const handleScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD
      setIsAtBottom(atBottom)
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll to bottom when new messages arrive and user is at bottom
  useEffect(() => {
    if (messages.length > prevMessageCount.current && isAtBottom) {
      virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
    }
    prevMessageCount.current = messages.length
  }, [messages.length, isAtBottom, virtualizer, viewItems.length])

  // Scroll to bottom on initial mount if messages exist
  useEffect(() => {
    if (viewItems.length > 0) {
      virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
      setIsAtBottom(true)
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Detect scroll-up near top and fetch older messages
  useEffect(() => {
    const el = parentRef.current
    if (!el) return

    const handleScroll = () => {
      if (isFetchingRef.current || isLoadingOlder) return
      if (el.scrollTop > SCROLL_TOP_TRIGGER_THRESHOLD) return

      const currentWindowSize = messages.length
      const hasOlder = totalMessageCount > currentWindowSize
      if (!hasOlder) return

      const offset = Math.max(0, totalMessageCount - currentWindowSize - FETCH_SIZE)
      const limit = FETCH_SIZE

      isFetchingRef.current = true
      fetchOlderMessages(workspaceId, sessionId, offset, limit).finally(() => {
        isFetchingRef.current = false
      })
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [messages.length, totalMessageCount, isLoadingOlder, fetchOlderMessages, workspaceId, sessionId])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    for (const message of visibleMessages) {
      if (message.role !== 'user') continue
      if (message.parts.length === 0) continue
      if (!message.parts.every((p) => p?.type === 'text')) continue
      const text = message.parts
        .map((p) => (p?.type === 'text' ? p.text : ''))
        .join('')
      if (!isWrapperShape(text)) continue
      if (detectCliMeta(text) !== null) continue
      if (warnedShapes.has(text)) continue
      warnedShapes.add(text)
      console.warn('cli-meta: unrecognized wrapper shape', {
        sample: text.slice(0, 160),
      })
    }
  }, [visibleMessages])

  const handleScrollToBottom = () => {
    virtualizer.scrollToIndex(viewItems.length - 1, { align: 'end' })
    setIsAtBottom(true)
  }

  if (messages.length === 0) {
    return (
      <div className="relative flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-3 max-w-3xl mx-auto w-full h-full">
          <ConversationEmptyState
            icon={<Bot className="w-8 h-8" />}
            title={t('emptyState.title')}
            description={t('emptyState.description')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1">
      <div ref={parentRef} className="absolute inset-0 overflow-y-auto">
        {isLoadingOlder && (
          <div className="p-3 max-w-3xl mx-auto w-full text-center">
            <div className="flex gap-1 justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
        <div
          className={`p-3 max-w-3xl mx-auto w-full relative ${fontSizeClass(chatFontSize)}`}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
            const item = viewItems[virtualItem.index]
            if (!item) return null
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '0.75rem',
                  right: '0.75rem',
                  transform: `translateY(${virtualItem.start}px)`,
                  contain: 'paint layout',
                }}
              >
                {renderViewItem(
                  item,
                  resultMap,
                  onOpenDrawer,
                  sessionId,
                  autoApprovedTools,
                )}
              </div>
            )
          })}
        </div>
        {isCompacting && (
          <div className="px-3 pb-3 max-w-3xl mx-auto w-full">
            <CompactingIndicator sessionId={sessionId} />
          </div>
        )}
      </div>
      {!isAtBottom && (
        <Button
          className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full bg-bg hover:bg-surface-hover"
          onClick={handleScrollToBottom}
          size="icon"
          type="button"
          variant="outline"
        >
          <ArrowDown className="size-4" />
        </Button>
      )}
    </div>
  )
}

function renderViewItem(
  item: ViewItem,
  resultMap: Map<string, Extract<import('./ChatMessageRenderer').RenderablePart, { type: 'tool_result' }>>,
  onOpenDrawer: (parentToolUseId: string) => void,
  sessionId: string,
  autoApprovedTools?: Record<string, 'auto' | 'readonly'>,
): React.ReactNode {
  if (item.kind === 'meta') {
    if (item.event.kind === 'slash-command') {
      return (
        <SlashCommandMessage
          key={item.messageId}
          event={item.event}
          messageId={item.messageId}
        />
      )
    }
    return (
      <MutedSystemNote
        key={item.messageId}
        kind="single"
        event={item.event}
      />
    )
  }
  if (item.kind === 'meta-paired') {
    return (
      <SlashCommandMessage
        key={item.messageIds[0]}
        event={item.slash}
        messageId={item.messageIds[0]}
      />
    )
  }

  const adapted = adaptChatMessage(item.message)

  if (adapted.role === 'system') {
    if (item.message.isCompactBoundary) {
      return <CompactBoundary key={adapted.id} />
    }
  }

  return (
    <ChatMessageRenderer
      key={adapted.id}
      message={adapted}
      resultMap={resultMap}
      onOpenDrawer={onOpenDrawer}
      sessionId={sessionId}
      autoApprovedTools={autoApprovedTools}
    />
  )
}
