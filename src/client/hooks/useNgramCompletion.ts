import { useRef, useCallback, useEffect } from 'react'
import { TrigramCompletion } from '../lib/ngram-completion'
import { useSentPrompts } from './useSentPrompts'

interface NgramCompletionAPI {
  suggest: (text: string) => string | null
  train: (text: string) => void
}

export function useNgramCompletion(
  workspaceId: string | undefined,
): NgramCompletionAPI {
  const modelRef = useRef(new TrigramCompletion())
  const prompts = useSentPrompts(workspaceId)

  useEffect(() => {
    modelRef.current.clear()
    for (const prompt of prompts) {
      modelRef.current.train(prompt)
    }
  }, [workspaceId, prompts])

  const suggest = useCallback((text: string) => {
    return modelRef.current.suggest(text)
  }, [])

  const train = useCallback((text: string) => {
    modelRef.current.train(text)
  }, [])

  return { suggest, train }
}
