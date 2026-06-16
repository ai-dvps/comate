import { useMemo } from 'react'
import { useChatStore } from '../stores/chat-store'

export function useSentPrompts(workspaceId: string | undefined): string[] {
  const history = useChatStore((s) =>
    workspaceId ? s.promptHistory[workspaceId] : undefined,
  )

  return useMemo(() => {
    const prompts: string[] = []
    for (const text of history ?? []) {
      const trimmed = text.trim()
      if (!trimmed) continue
      if (prompts.length > 0 && prompts[prompts.length - 1] === trimmed) continue
      prompts.push(trimmed)
    }
    return prompts.reverse()
  }, [history])
}
