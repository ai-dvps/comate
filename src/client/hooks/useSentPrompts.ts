import { useMemo } from 'react'
import { useChatStore } from '../stores/chat-store'

export function useSentPrompts(sessionId: string | undefined): string[] {
  const messages = useChatStore((s) =>
    sessionId ? (s.messages[sessionId] ?? []) : [],
  )

  return useMemo(() => {
    const prompts: string[] = []
    for (const message of messages) {
      if (message.role !== 'user') continue
      const textPart = message.parts.find((p) => p.type === 'text')
      const text = textPart?.type === 'text' ? textPart.text.trim() : ''
      if (!text) continue
      if (prompts.length > 0 && prompts[prompts.length - 1] === text) continue
      prompts.push(text)
    }
    return prompts.reverse()
  }, [messages])
}
