import { Copy, FileCode2, LoaderCircle, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitGraphChangedFile, GitGraphCommit, GitGraphCommitDetail } from '../../stores/git-graph-store'
import { cn } from '../ui/utils'

interface GitCommitDetailsProps {
  commit: GitGraphCommit | null
  detail: GitGraphCommitDetail | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpenFile: (file: GitGraphChangedFile) => void
}

function statusLabel(file: GitGraphChangedFile): string {
  if (file.isGitlink) return 'SUBMODULE'
  if (file.isBinary) return 'BINARY'
  return file.status
}

export default function GitCommitDetails({ commit, detail, loading, error, onRetry, onOpenFile }: GitCommitDetailsProps) {
  const { t, i18n } = useTranslation('common')
  const [copied, setCopied] = useState(false)

  if (!commit) {
    return <div className="flex h-full items-center justify-center px-4 text-xs text-text-tertiary">{t('gitGraph.selectCommit')}</div>
  }

  const copySha = async () => {
    await navigator.clipboard?.writeText(commit.hash)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section aria-label={t('gitGraph.commitDetails')} className="flex h-full min-h-0 flex-col bg-chrome/40">
      <header className="flex flex-none items-start gap-3 border-b border-border/70 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-medium text-text-primary">{commit.subject}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-tertiary">
            <span>{commit.authorName} &lt;{commit.authorEmail}&gt;</span>
            <time dateTime={commit.authoredAt}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(commit.authoredAt))}</time>
            <code>{commit.hash}</code>
          </div>
        </div>
        <button type="button" className="flex h-7 w-7 flex-none items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void copySha()} aria-label={copied ? t('gitGraph.shaCopied') : t('gitGraph.copySha')}>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <div className="flex min-h-24 flex-1 items-center justify-center gap-2 text-xs text-text-tertiary" role="status">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('gitGraph.loadingDetails')}
        </div>
      ) : error ? (
        <div className="flex min-h-24 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs">
          <p className="text-destructive">{error}</p>
          <button type="button" className="flex h-7 items-center gap-1 rounded border border-border px-2 text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onRetry} aria-label={t('gitGraph.retryDetails')}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('gitGraph.retry')}
          </button>
        </div>
      ) : detail ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1.5 text-[10px] text-text-tertiary">
            <span>{t('gitGraph.fileCount', { count: detail.stats.files })}</span>
            <span className="text-success">+{detail.stats.additions}</span>
            <span className="text-destructive">−{detail.stats.deletions}</span>
            {detail.parents.length > 1 ? <span>{t('gitGraph.firstParentBaseline')}</span> : null}
            {detail.filesTruncated ? <span>{t('gitGraph.filesTruncated')}</span> : null}
          </div>
          <div role="list" aria-label={t('gitGraph.changedFiles')}>
            {detail.files.length === 0 ? (
              <div className="px-3 py-4 text-xs text-text-tertiary">{t('gitGraph.noChangedFiles')}</div>
            ) : detail.files.map((file) => (
              <div key={`${file.oldPath ?? ''}:${file.path}`} role="listitem">
                <button
                  type="button"
                  onClick={() => onOpenFile(file)}
                  className="flex min-h-8 w-full items-center gap-2 border-b border-border/35 px-3 py-1 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  aria-label={`${file.path}, ${statusLabel(file)}`}
                >
                  <FileCode2 className="h-3.5 w-3.5 flex-none text-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary">
                    {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                  <span className={cn('text-[9px] font-semibold', file.status === 'D' ? 'text-destructive' : file.status === 'A' ? 'text-success' : 'text-text-secondary')}>
                    {statusLabel(file)}
                  </span>
                  {file.additions !== null ? <span className="text-[10px] text-success">+{file.additions}</span> : null}
                  {file.deletions !== null ? <span className="text-[10px] text-destructive">−{file.deletions}</span> : null}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
