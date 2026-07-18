import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import type { LanguageSupport } from '@codemirror/language'

export function getCodeMirrorLanguage(filename: string): LanguageSupport | null {
  const ext = filename.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'md':
    case 'markdown':
      return markdown()
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return cpp()
    case 'java':
      return java()
    case 'php':
      return php()
    case 'sql':
      return sql()
    case 'xml':
    case 'svg':
      return xml()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'html':
    case 'htm':
      return html()
    case 'css':
      return css()
    default:
      return null
  }
}
