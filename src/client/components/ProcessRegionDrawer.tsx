import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, X } from 'lucide-react'

import { useChatStore } from '../stores/chat-store'
import { adaptChatMessage, buildResultMap } from './chat-message-adapter'
import type { RenderableMessage, RenderablePart } from './chat-message-adapter'
import { groupMessageParts } from './message-grouping'
import ChatMessageRenderer from './ChatMessageRenderer'
import type { ChatMessage } from '../types/message'

interface ProcessRegionDrawerProps {
  messageId: string
  regionIndex: number
  sessionId: string
  width: number
  onClose: () => void
  onWidthChange: (width: number) => void
}

const MIN_WIDTH = 300
const MAX_WIDTH = 600

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Side drawer for one process region: renders that region's thinking + tool-use
 * steps (with their results) linearly, by reusing ChatMessageRenderer in linear
 * mode. Mirrors SubagentDrawer's resizable aside, adds Escape + focus management.
 */
export default function ProcessRegionDrawer({
  messageId,
  regionIndex,
  sessionId,
  width,
  onClose,
  onWidthChange,
}: ProcessRegionDrawerProps) {
  const { t } = useTranslation('chat')
  const asideRef = useRef<HTMLElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const messages = useChatStore((s) => s.messages[sessionId] ?? [])
  // messageId may be a '|'-joined set of source ids when a turn spanned multiple
  // assistant messages (see mergeAssistantTurns).
  const turnMessages = useMemo(
    () =>
      messageId
        .split('|')
        .map((id) => messages.find((m) => m.id === id))
        .filter((m): m is ChatMessage => Boolean(m)),
    [messages, messageId],
  )
  // Session-level resultMap so tool_results (separate messages) link to tool_use.
  const resultMap = useMemo(() => buildResultMap(messages), [messages])

  const region = useMemo(() => {
    if (turnMessages.length === 0) return null
    const parts: RenderablePart[] = []
    for (const m of turnMessages) parts.push(...adaptChatMessage(m).parts)
    return groupMessageParts(parts)[regionIndex] ?? null
  }, [turnMessages, regionIndex])

  // Focus management: move focus in on open, trap Tab, restore focus on close.
  useEffect(() => {
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null
    const aside = asideRef.current
    aside?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !aside) return
      const focusable = Array.from(
        aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previouslyFocused.current?.focus?.()
    }
  }, [onClose])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)))
      }
      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [width, onWidthChange],
  )

  const stepCount = region?.type === 'process' ? region.parts.length : 0
  const detailMessage: RenderableMessage | null =
    region?.type === 'process'
      ? {
          id: `${messageId}-r${regionIndex}`,
          role: 'assistant',
          timestamp: turnMessages[0]?.timestamp,
          parts: region.parts,
        }
      : null

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      role="dialog"
      aria-label={t('displayMode.drawerTitle', { count: stepCount })}
      className="relative flex h-full flex-shrink-0 flex-col border-l border-border bg-surface outline-none"
      style={{ width }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-accent/50"
        onMouseDown={handleMouseDown}
      />

      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="size-4 shrink-0 text-text-tertiary" />
          <span className="truncate text-sm font-medium text-text-primary">
            {t('displayMode.drawerTitle', { count: stepCount })}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label={t('close')}
          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {detailMessage ? (
          <ChatMessageRenderer
            key={detailMessage.id}
            message={detailMessage}
            resultMap={resultMap}
            onOpenDrawer={() => {}}
            sessionId={sessionId}
            displayMode="linear"
          />
        ) : (
          <div className="text-sm text-text-secondary">
            {t('displayMode.emptyRegion')}
          </div>
        )}
      </div>
    </aside>
  )
}
