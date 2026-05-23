import { X, Copy, Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CodeBlockContent } from './ai-elements/code-block'
import { getLanguageFromFilename } from '../lib/language'

export interface ViewedFile {
  path: string
  name: string
  content: string
}

interface FileDrawerProps {
  file: ViewedFile | null
  onClose: () => void
  onPin: () => void
  onCopy: () => void
}

export default function FileDrawer({ file, onClose, onPin, onCopy }: FileDrawerProps) {
  const { t } = useTranslation('common')
  if (!file) return null

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed right-0 top-12 bottom-0 bg-overlay/40 z-40"
        style={{ left: '18rem' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        className="fixed top-12 h-[calc(100%-3rem)] bg-surface border-r border-border z-50 flex flex-col shadow-2xl drawer"
        style={{
          left: '18rem',
          width: 'calc(50vw - 9rem)',
          minWidth: '320px',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
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
            <span className="text-sm text-text-primary font-mono truncate">
              {file.name}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={onCopy}
              className="px-2 py-1.5 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              title={t('copyContent')}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onPin}
              className="px-2 py-1.5 rounded-md text-xs text-accent hover:text-accent-hover hover:bg-surface-hover transition-colors"
              title={t('pinSideBySide')}
            >
              <Pin className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
              title={t('close')}
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
    </>
  )
}
