interface PromptGhostTextProps {
  input: string
  argumentHint: string | null
  lastInsertedCommand: string | null
}

export default function PromptGhostText({
  input,
  argumentHint,
  lastInsertedCommand,
}: PromptGhostTextProps) {
  if (!argumentHint || input !== lastInsertedCommand) return null

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
        const trailingWhitespace = isLast ? (line.match(/\s*$/)?.[0] ?? '') : ''
        const referenceText = isLast
          ? line.slice(0, line.length - trailingWhitespace.length)
          : line
        if (line === '' && !showGhost) {
          return <div key={index} className="whitespace-pre-wrap break-words"><br /></div>
        }
        return (
          <div
            key={index}
            className="whitespace-pre-wrap break-words"
          >
            {referenceText ? (
              <span
                className={isLast
                  ? 'invisible prompt-reference-chip prompt-reference-chip--skill'
                  : 'invisible'}
              >
                {referenceText}
              </span>
            ) : null}
            {trailingWhitespace ? (
              <span className="invisible">{trailingWhitespace}</span>
            ) : null}
            {showGhost ? (
              <span className="text-text-tertiary">{argumentHint}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
