import { useRef, useCallback, useEffect } from 'react'
import { TrigramCompletion } from '../lib/ngram-completion'

interface NgramCompletionAPI {
  suggest: (text: string) => string | null
  train: (text: string) => void
}

export function useNgramCompletion(
  sessionId: string | undefined,
): NgramCompletionAPI {
  const modelRef = useRef(new TrigramCompletion())

  useEffect(() => {
    modelRef.current.clear()
  }, [sessionId])

  const suggest = useCallback((text: string) => {
    return modelRef.current.suggest(text)
  }, [])

  const train = useCallback((text: string) => {
    modelRef.current.train(text)
  }, [])

  return { suggest, train }
}
