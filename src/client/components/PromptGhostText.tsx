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

  const lines = input.split('\n')
  const lastIndex = lines.length - 1

  return (
    <div
      aria-hidden
      className="absolute inset-0 z-20 px-4 py-3 pointer-events-none"
    >
      {lines.map((line, index) => {
        const isLast = index === lastIndex
        const showGhost = isLast
        if (line === '' && !showGhost) {
          return <div key={index} className="whitespace-pre-wrap break-words"><br /></div>
        }
        return (
          <div
            key={index}
            className="whitespace-pre-wrap break-words"
          >
            <span className="invisible">{line}</span>
            {showGhost ? (
              <span className="text-text-tertiary">{ghost}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
