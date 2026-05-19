import { X, Copy } from 'lucide-react'
import type { BundledLanguage } from 'shiki'
import type { ViewedFile } from './FileDrawer'
import { CodeBlockContent } from './ai-elements/code-block'

const EXT_TO_LANGUAGE: Record<string, BundledLanguage> = {
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  ps1: 'powershell',
  pl: 'perl',
  kt: 'kotlin',
  kts: 'kotlin',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  fs: 'fsharp',
  fsx: 'fsharp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  vim: 'viml',
  dockerfile: 'dockerfile',
  tf: 'hcl',
  hcl: 'hcl',
  yml: 'yaml',
  m: 'objc',
  mm: 'objc',
}

export function getLanguageFromFilename(name: string): BundledLanguage {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'text' as BundledLanguage
  return EXT_TO_LANGUAGE[ext] ?? (ext as BundledLanguage)
}

interface FilePanelProps {
  file: ViewedFile | null
  onClose: () => void
  onCopy: () => void
}

export default function FilePanel({ file, onClose, onCopy }: FilePanelProps) {
  if (!file) return null

  return (
    <aside className="w-96 bg-surface border-r border-border flex flex-col flex-shrink-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 flex-shrink-0"
      >
        <div className="flex items-center gap-2 min-w-0"
        >
          <svg
            className="w-4 h-4 text-text-tertiary flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="text-sm text-text-primary font-mono truncate"
          >
            {file.name}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0"
        >
          <button
            onClick={onCopy}
            className="px-2 py-1.5 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Copy content"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <CodeBlockContent
          code={file.content}
          language={getLanguageFromFilename(file.name)}
          showLineNumbers={true}
          className="!p-0"
        />
      </div>
    </aside>
  )
}
