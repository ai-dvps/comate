export type PromptReferenceKind = 'skill' | 'file'

export interface PromptReference {
  kind: PromptReferenceKind
  value: string
  start: number
  end: number
}

const REFERENCE_PATTERN = /(^|\s)([/@])(\S+)/g

export function scanPromptReferences(input: string): PromptReference[] {
  const references: PromptReference[] = []
  let match: RegExpExecArray | null

  REFERENCE_PATTERN.lastIndex = 0
  while ((match = REFERENCE_PATTERN.exec(input)) !== null) {
    const start = match.index + match[1].length
    const value = match[3]
    references.push({
      kind: match[2] === '/' ? 'skill' : 'file',
      value,
      start,
      end: start + 1 + value.length,
    })
  }
  return references
}
