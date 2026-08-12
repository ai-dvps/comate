export interface BrowserDeclarationPayload {
  kind: 'browser_declaration'
  origin: string
  intendedState: boolean
  declaration: { source: 'untrusted_page'; text: string }
  taskSummary: {
    source: 'derived_metadata'
    taskVersion: number
    populatedSlots: number
    verifiedSlots: number
    mediaSlots: number
  }
}

export function parseBrowserDeclarationInput(input: unknown): BrowserDeclarationPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const allowed = new Set(['kind', 'origin', 'intendedState', 'declaration', 'taskSummary'])
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.kind !== 'browser_declaration' ||
      typeof record.origin !== 'string' || typeof record.intendedState !== 'boolean') return null
  const declaration = record.declaration as Record<string, unknown> | undefined
  const summary = record.taskSummary as Record<string, unknown> | undefined
  if (!declaration || Object.keys(declaration).some((key) => !['source', 'text'].includes(key)) ||
      declaration.source !== 'untrusted_page' || typeof declaration.text !== 'string' || declaration.text.length > 600) return null
  if (!summary || Object.keys(summary).some((key) => !['source', 'taskVersion', 'populatedSlots', 'verifiedSlots', 'mediaSlots'].includes(key)) ||
      summary.source !== 'derived_metadata') return null
  for (const key of ['taskVersion', 'populatedSlots', 'verifiedSlots', 'mediaSlots']) {
    if (!Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0) return null
  }
  return record as unknown as BrowserDeclarationPayload
}
