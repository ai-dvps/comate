import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, MessagePart } from '../types/message'

export interface MessageSearchMatch {
  messageId: string
  partIndex: number
  start: number
  end: number
}

export interface SearchHighlightRange {
  start: number
  end: number
  isActive: boolean
}

export interface UseMessageSearchOptions {
  messages: ChatMessage[]
  debounceMs?: number
}

export interface UseMessageSearchResult {
  query: string
  setQuery: (query: string) => void
  matches: MessageSearchMatch[]
  currentMatch: MessageSearchMatch | null
  currentMatchIndex: number
  totalMatches: number
  nextMatch: () => void
  prevMatch: () => void
  isSearching: boolean
}

function getPartSearchText(part: MessagePart): string {
  switch (part.type) {
    case 'text':
    case 'thinking':
      return part.text
    case 'tool_result':
      return part.output
    case 'tool_use': {
      const pieces: string[] = [part.toolName]
      if (typeof part.inputJsonStream === 'string' && part.inputJsonStream.length > 0) {
        pieces.push(part.inputJsonStream)
      } else if (part.input !== undefined) {
        pieces.push(
          typeof part.input === 'string'
            ? part.input
            : JSON.stringify(part.input),
        )
      }
      return pieces.join(' ')
    }
    default:
      return ''
  }
}

export function findMessageSearchMatches(
  messages: ChatMessage[],
  query: string,
): MessageSearchMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const matches: MessageSearchMatch[] = []

  for (const message of messages) {
    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex]
      const text = getPartSearchText(part).toLowerCase()
      let index = text.indexOf(needle)
      while (index !== -1) {
        matches.push({
          messageId: message.id,
          partIndex,
          start: index,
          end: index + needle.length,
        })
        index = text.indexOf(needle, index + needle.length)
      }
    }
  }

  return matches
}

export function useMessageSearch({
  messages,
  debounceMs = 150,
}: UseMessageSearchOptions): UseMessageSearchResult {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(query)
    }, debounceMs)
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [query, debounceMs])

  // Reset to the first match whenever the search query changes.
  useEffect(() => {
    setCurrentMatchIndex(0)
  }, [debouncedQuery])

  const matches = useMemo(
    () => findMessageSearchMatches(messages, debouncedQuery),
    [messages, debouncedQuery],
  )

  // Clamp the current index when the match list shrinks or expands, but try
  // to preserve the user's position when messages stream in.
  useEffect(() => {
    setCurrentMatchIndex((prev) => {
      if (matches.length === 0) return 0
      if (prev >= matches.length) return matches.length - 1
      return prev
    })
  }, [matches.length])

  const nextMatch = useCallback(() => {
    setCurrentMatchIndex((prev) =>
      matches.length === 0 ? 0 : (prev + 1) % matches.length,
    )
  }, [matches.length])

  const prevMatch = useCallback(() => {
    setCurrentMatchIndex((prev) =>
      matches.length === 0
        ? 0
        : (prev - 1 + matches.length) % matches.length,
    )
  }, [matches.length])

  const currentMatch = matches[currentMatchIndex] ?? null
  const isSearching = query !== debouncedQuery

  return {
    query,
    setQuery,
    matches,
    currentMatch,
    currentMatchIndex,
    totalMatches: matches.length,
    nextMatch,
    prevMatch,
    isSearching,
  }
}
