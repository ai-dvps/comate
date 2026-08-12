interface TaggedText {
  source: 'untrusted_page'
  text: string
}

interface FinalReviewSlot {
  source: 'derived_metadata'
  category: string
  required: boolean
  disposition: 'authority_confirmed' | 'verified' | 'pending_validation' | 'empty'
  populationBucket: 'empty' | 'short' | 'medium' | 'long' | 'present'
}

interface FinalReview {
  source: 'user_intent'
  taskVersion: number
  slots: FinalReviewSlot[]
  mediaCount: number
  declarationDisposition: 'confirmed' | 'unresolved' | 'not_present'
  visibilityDisposition: 'verified' | 'not_present'
}

export interface BrowserActivationPayload {
  kind: 'browser_activation'
  warning: string
  origin: string
  target: { role?: TaggedText; name?: TaggedText; nearbyContext?: TaggedText }
  editorSummary?: { editorCount?: number; filledEditorCount?: number; totalEditorLength?: number }
  reconfirmation?: boolean
  differences?: string[]
  finalReview?: FinalReview
}

function tagged(value: unknown): value is TaggedText {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.source === 'untrusted_page' && typeof record.text === 'string'
}

export function parseBrowserActivationInput(input: unknown): BrowserActivationPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const allowed = new Set(['kind', 'warning', 'origin', 'target', 'editorSummary', 'reconfirmation', 'differences', 'finalReview'])
  if (Object.keys(record).some((key) => !allowed.has(key))) return null
  if (record.kind !== 'browser_activation' || typeof record.warning !== 'string' || typeof record.origin !== 'string') return null
  const target = record.target as Record<string, unknown> | undefined
  if (!target || (target.role !== undefined && !tagged(target.role)) ||
      (target.name !== undefined && !tagged(target.name)) ||
      (target.nearbyContext !== undefined && !tagged(target.nearbyContext))) return null
  if (record.finalReview !== undefined && !validFinalReview(record.finalReview)) return null
  return record as unknown as BrowserActivationPayload
}

function validFinalReview(input: unknown): input is FinalReview {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  if (Object.keys(record).some((key) => !['source', 'taskVersion', 'slots', 'mediaCount', 'declarationDisposition', 'visibilityDisposition'].includes(key)) ||
      record.source !== 'user_intent' || !Number.isSafeInteger(record.taskVersion) || (record.taskVersion as number) < 0 ||
      !Number.isSafeInteger(record.mediaCount) || (record.mediaCount as number) < 0 || (record.mediaCount as number) > 64 ||
      !['confirmed', 'unresolved', 'not_present'].includes(String(record.declarationDisposition)) ||
      !['verified', 'not_present'].includes(String(record.visibilityDisposition)) ||
      !Array.isArray(record.slots) || record.slots.length > 64) return false
  return record.slots.every((slot) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false
    const item = slot as Record<string, unknown>
    return !Object.keys(item).some((key) => !['source', 'category', 'required', 'disposition', 'populationBucket'].includes(key)) &&
      item.source === 'derived_metadata' && typeof item.category === 'string' && item.category.length <= 64 &&
      typeof item.required === 'boolean' && ['authority_confirmed', 'verified', 'pending_validation', 'empty'].includes(String(item.disposition)) &&
      ['empty', 'short', 'medium', 'long', 'present'].includes(String(item.populationBucket))
  })
}
