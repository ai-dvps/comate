import { useMemo, forwardRef } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-markdown'

interface MarkdownOverlayProps {
  value: string
  hidden?: boolean
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function dimPunctuation(text: string): string {
  return `<span class="token punctuation">${escapeHtml(text)}</span>`
}

function splitToken(text: string, prefix: string, suffix: string): string {
  if (!text.startsWith(prefix)) return escapeHtml(text)
  const inner = text.slice(prefix.length, text.length - suffix.length)
  return `${dimPunctuation(prefix)}${escapeHtml(inner)}${dimPunctuation(suffix)}`
}

function processToken(type: string, text: string): string {
  switch (type) {
    case 'code':
    case 'code-snippet':
      // inline code: `content`
      if (text.startsWith('`') && text.endsWith('`')) {
        return splitToken(text, '`', '`')
      }
      break
    case 'bold':
      // **content** or __content__
      if (text.startsWith('**') && text.endsWith('**')) {
        return splitToken(text, '**', '**')
      }
      if (text.startsWith('__') && text.endsWith('__')) {
        return splitToken(text, '__', '__')
      }
      break
    case 'italic':
      // *content* or _content_
      if (text.startsWith('*') && text.endsWith('*')) {
        return splitToken(text, '*', '*')
      }
      if (text.startsWith('_') && text.endsWith('_')) {
        return splitToken(text, '_', '_')
      }
      break
    case 'strike':
      // ~~content~~
      if (text.startsWith('~~') && text.endsWith('~~')) {
        return splitToken(text, '~~', '~~')
      }
      break
    case 'title':
      // ATX heading title may still include trailing hashes; dim any leading
      // sequence so the marker does not show as body text.
      {
        const match = text.match(/^(#{1,6}\s*)(.*?)(\s*#*)$/)
        if (match) {
          const [, lead, inner, trail] = match
          return `${dimPunctuation(lead)}${escapeHtml(inner)}${trail ? dimPunctuation(trail) : ''}`
        }
      }
      break
  }
  return escapeHtml(text)
}

function renderTokens(tokens: Array<string | Prism.Token>): string {
  return tokens
    .map((token) => {
      if (typeof token === 'string') return escapeHtml(token)
      const t = token as Prism.Token
      const type = t.type
      const alias = Array.isArray(t.alias)
        ? t.alias.join(' ')
        : typeof t.alias === 'string'
          ? t.alias
          : undefined

      let inner: string
      if (Array.isArray(t.content)) {
        inner = renderTokens(t.content)
      } else {
        inner = processToken(type, String(t.content))
      }

      const classes = ['token', type, alias].filter(Boolean).join(' ')
      return `<span class="${classes}">${inner}</span>`
    })
    .join('')
}

const MarkdownOverlay = forwardRef<HTMLPreElement, MarkdownOverlayProps>(
  function MarkdownOverlay({ value, hidden = false }, ref) {
    const html = useMemo(() => {
      const tokens = Prism.tokenize(value, Prism.languages.markdown)
      return renderTokens(tokens) + '<span>&#x200B;</span>'
    }, [value])

    return (
      <pre
        ref={ref}
        aria-hidden
        className="md-overlay absolute inset-0 px-4 py-3 text-text-primary font-sans whitespace-pre-wrap break-words overflow-y-auto overflow-x-hidden pointer-events-none z-0"
        style={{ visibility: hidden ? 'hidden' : 'visible' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  },
)

export default MarkdownOverlay
