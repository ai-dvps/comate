/**
 * Payload shape + parser for the embedded browser's submit confirmation
 * (U4, KTD-4 ②). The submit tool's handler-level gate emits a sanitized
 * payload (`kind: 'browser_submit'`): sensitive fields are listed by name
 * only — their values never enter the pending_approval event stream (KTD-8).
 */

export interface BrowserSubmitField {
  name: string
  type: string
  sensitive: boolean
  /** Present only for non-sensitive fields. */
  value?: string
}

export interface BrowserSubmitPayload {
  kind: 'browser_submit'
  pageUrl?: string
  formName?: string
  action?: string
  actionOrigin?: string
  method?: string
  fields?: BrowserSubmitField[]
  reconfirmation?: boolean
  differences?: Array<{ field?: string; kind: string }>
}

/** Parse a pending_approval input into a submit payload, or null. */
export function parseBrowserSubmitInput(input: unknown): BrowserSubmitPayload | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (record.kind !== 'browser_submit') return null
  return record as unknown as BrowserSubmitPayload
}
