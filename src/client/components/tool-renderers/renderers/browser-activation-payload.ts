interface TaggedText {
  source: 'untrusted_page'
  text: string
}

export interface BrowserActivationPayload {
  kind: 'browser_activation'
  warning: string
  origin: string
  target: { role?: TaggedText; name?: TaggedText; nearbyContext?: TaggedText }
  editorSummary?: { editorCount?: number; filledEditorCount?: number; totalEditorLength?: number }
  reconfirmation?: boolean
  differences?: string[]
}

function tagged(value: unknown): value is TaggedText {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.source === 'untrusted_page' && typeof record.text === 'string'
}

export function parseBrowserActivationInput(input: unknown): BrowserActivationPayload | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (record.kind !== 'browser_activation' || typeof record.warning !== 'string' || typeof record.origin !== 'string') return null
  const target = record.target as Record<string, unknown> | undefined
  if (!target || (target.role !== undefined && !tagged(target.role)) ||
      (target.name !== undefined && !tagged(target.name)) ||
      (target.nearbyContext !== undefined && !tagged(target.nearbyContext))) return null
  return record as unknown as BrowserActivationPayload
}
