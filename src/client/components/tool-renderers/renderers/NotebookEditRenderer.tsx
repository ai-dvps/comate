import { FileCode } from 'lucide-react'
import type { ReactNode } from 'react'
import { registerToolRenderer } from '../registry'

export default function NotebookEditRenderer(input: unknown): ReactNode | null {
  if (!input || typeof input !== 'object') return null

  const { notebook_path, cell_id, new_source, cell_type, edit_mode } = input as Record<string, unknown>

  if (!notebook_path || typeof notebook_path !== 'string') return null

  const mode = typeof edit_mode === 'string' ? edit_mode : 'update'
  const type = typeof cell_type === 'string' ? cell_type : undefined

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <FileCode className="size-3.5 text-text-tertiary shrink-0" />
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Notebook</span>
        <span className="text-text-secondary text-sm font-mono truncate" title={notebook_path}>{notebook_path}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Mode</span>
        <span className="text-text-secondary text-sm capitalize">{mode}</span>
      </div>
      {typeof cell_id === 'string' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Cell</span>
          <span className="text-text-secondary text-sm font-mono">{cell_id}</span>
        </div>
      )}
      {type && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Type</span>
          <span className="text-text-secondary text-sm capitalize">{type}</span>
        </div>
      )}
      {typeof new_source === 'string' && new_source.length > 0 && (
        <div className="flex items-start gap-2">
          <span className="text-text-tertiary text-xs uppercase tracking-wide shrink-0">Source</span>
          <span className="text-text-secondary text-sm whitespace-pre-wrap break-words font-mono">{new_source}</span>
        </div>
      )}
    </div>
  )
}

registerToolRenderer('NotebookEdit', NotebookEditRenderer)
