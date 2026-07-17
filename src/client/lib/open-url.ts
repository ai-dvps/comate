import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri-api'

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"']+$/

export interface TextSegment {
  type: 'text' | 'url'
  content: string
  /** The clean URL to open when this segment is a URL. */
  href?: string
}

/**
 * Split plain text into URL and non-URL segments.
 * Trailing punctuation commonly attached to URLs in prose is stripped from the
 * clickable href but left in the rendered text.
 */
export function splitTextByUrls(text: string): TextSegment[] {
  if (!text) return [{ type: 'text', content: text }]

  const segments: TextSegment[] = []
  let lastIndex = 0
  URL_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = URL_REGEX.exec(text)) !== null) {
    const start = match.index
    const rawUrl = match[0]
    const href = rawUrl.replace(TRAILING_PUNCTUATION, '')

    if (start > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, start) })
    }
    segments.push({ type: 'url', content: rawUrl, href })
    lastIndex = start + rawUrl.length
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return segments
}

/**
 * Open an http/https URL in the system default browser.
 *
 * In the Tauri shell this delegates to the Rust `open_url` command; in a plain
 * browser (dev:client, Playwright tests) it falls back to `window.open`.
 * Failures are caught and logged so a click never produces an unhandled
 * promise rejection.
 */
export async function openUrlInBrowser(url: string): Promise<void> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.warn('[open-url] Unsupported URL scheme:', url)
    return
  }

  try {
    if (isTauri()) {
      await invoke('open_url', { url })
    } else {
      window.open(url, '_blank', 'noopener')
    }
  } catch (error) {
    console.warn('[open-url] Failed to open URL:', url, error)
  }
}
