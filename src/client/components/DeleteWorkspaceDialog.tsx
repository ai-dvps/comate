import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, AlertTriangle } from 'lucide-react'

interface DeleteWorkspaceDialogProps {
  workspaceName: string
  isOpen: boolean
  isLoading?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function DeleteWorkspaceDialog({
  workspaceName,
  isOpen,
  isLoading = false,
  onCancel,
  onConfirm,
}: DeleteWorkspaceDialogProps) {
  const { t } = useTranslation('settings')
  const [inputValue, setInputValue] = useState('')

  const normalizedInput = inputValue.trim()
  const normalizedName = workspaceName.trim()
  const canConfirm = normalizedInput === normalizedName && !isLoading

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return
    onConfirm()
  }, [canConfirm, onConfirm])

  useEffect(() => {
    if (!isOpen) {
      setInputValue('')
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' && !e.shiftKey && canConfirm) {
        e.preventDefault()
        handleConfirm()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel, canConfirm, handleConfirm])

  if (!isOpen) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-workspace-title"
      aria-describedby="delete-workspace-description"
      className="fixed top-11 inset-x-0 bottom-0 z-50 flex items-start justify-center pt-16"
    >
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/50 flex-shrink-0">
          <h2
            id="delete-workspace-title"
            className="text-sm font-medium text-text-primary flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-destructive" />
            {t('deleteWorkspace.title')}
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <div
            id="delete-workspace-description"
            className="text-xs text-text-secondary space-y-2"
          >
            <p>
              {t('deleteWorkspace.warning', { workspaceName })}
            </p>
            <p className="text-text-tertiary">
              {t('deleteWorkspace.folderUntouched')}
            </p>
          </div>

          <div>
            <label
              htmlFor="delete-workspace-confirm"
              className="block text-xs font-medium text-text-secondary mb-1.5"
            >
              {t('deleteWorkspace.inputLabel')}
            </label>
            <input
              id="delete-workspace-confirm"
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={t('deleteWorkspace.inputPlaceholder')}
              aria-describedby="delete-workspace-description"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-destructive text-text-primary placeholder:text-text-tertiary"
            />
            {normalizedInput.length > 0 && normalizedInput !== normalizedName && (
              <p className="text-xs text-destructive mt-1.5">
                {t('deleteWorkspace.nameMismatch')}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 flex-shrink-0">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
          >
            {t('deleteWorkspace.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-destructive hover:bg-destructive/90 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {isLoading ? t('deleteWorkspace.deleting') : t('deleteWorkspace.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
