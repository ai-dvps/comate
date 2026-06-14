interface PromptGhostTextProps {
  input: string
  argumentHint: string | null
  lastInsertedCommand: string | null
  completionSuggestion: string | null
}

export default function PromptGhostText({
  input,
  argumentHint,
  lastInsertedCommand,
  completionSuggestion,
}: PromptGhostTextProps) {
  const showArgumentHint = !!argumentHint && input === lastInsertedCommand
  const ghost = showArgumentHint
    ? argumentHint
    : completionSuggestion

  if (!ghost) return null

  return (
    <div
      aria-hidden
      className="absolute inset-0 z-20 px-4 py-3 pointer-events-none whitespace-pre-wrap break-words"
    >
      <span className="invisible">{input}</span>
      <span className="text-text-tertiary">{ghost}</span>
    </div>
  )
}
