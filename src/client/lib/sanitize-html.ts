import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'code', 'kbd', 'mark',
  'ul', 'ol', 'li',
  'pre',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a',
  'blockquote',
]

const ALLOWED_ATTR = ['href']

const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#)/i

let hookRegistered = false

function registerHooksOnce() {
  if (hookRegistered) return
  hookRegistered = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

export function sanitizePreviewHtml(html: string): string {
  registerHooksOnce()
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    KEEP_CONTENT: true,
  })
}
