export interface BrowserUploadFile {
  source: 'workspace_file'
  name: string
  mediaType: string
  size: number
}

export interface BrowserUploadPayload {
  kind: 'browser_upload'
  warning: string
  origin: string
  files: BrowserUploadFile[]
  totalBytes: number
  target?: { multiple?: boolean; accept?: { source: 'untrusted_page'; text: string } }
}

export function parseBrowserUploadInput(input: unknown): BrowserUploadPayload | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (record.kind !== 'browser_upload' || typeof record.warning !== 'string' || typeof record.origin !== 'string' ||
      !Array.isArray(record.files) || typeof record.totalBytes !== 'number') return null
  const files = record.files as Array<Record<string, unknown>>
  if (!files.every((file) => file.source === 'workspace_file' && typeof file.name === 'string' &&
      typeof file.mediaType === 'string' && typeof file.size === 'number')) return null
  return record as unknown as BrowserUploadPayload
}
