import { useEffect, useMemo, useRef } from 'react'

import type { SubagentMessage } from '../stores/chat-store'
import ChatMessageRenderer, {
  adaptSubagentMessage,
  buildResultMap,
} from './ChatMessageRenderer'

interface SubagentConversationProps {
  messages: SubagentMessage[]
  isRunning: boolean
  sessionId: string
}

export default function SubagentConversation({
  messages,
  isRunning,
  sessionId,
}: SubagentConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isRunning) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, isRunning])

  const resultMap = useMemo(() => buildResultMap(messages), [messages])

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        Subagent started... waiting for output
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 p-4">
      {messages.map((msg) => {
        const adapted = adaptSubagentMessage(msg, isRunning)
        return (
          <ChatMessageRenderer
            key={msg.id}
            message={adapted}
            resultMap={resultMap}
            onOpenDrawer={() => {}}
            sessionId={sessionId}
          />
        )
      })}
    </div>
  )
}
