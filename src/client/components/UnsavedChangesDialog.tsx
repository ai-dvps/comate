import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, AlertTriangle, Loader2 } from 'lucide-react';

interface UnsavedChangesDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  onSave: () => void | Promise<void>;
  onDiscard: () => void;
  onKeepEditing: () => void;
  isSaving?: boolean;
  saveLabel?: string;
  discardLabel?: string;
  keepEditingLabel?: string;
}

export default function UnsavedChangesDialog({
  isOpen,
  title,
  message,
  onSave,
  onDiscard,
  onKeepEditing,
  isSaving = false,
  saveLabel,
  discardLabel,
  keepEditingLabel,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation('settings');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement;
      dialogRef.current?.focus();
    } else {
      if (
        previousActiveElement.current instanceof HTMLElement &&
        document.contains(previousActiveElement.current)
      ) {
        previousActiveElement.current.focus();
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onKeepEditing();
    } else if (e.key === 'Enter' && !isSaving) {
      e.stopPropagation();
      void onSave();
    }
  };

  const handleDialogClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  return (
    <div className="fixed top-11 inset-x-0 bottom-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={onKeepEditing} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={handleDialogClick}
        onKeyDown={handleKeyDown}
        className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 outline-none"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-text-primary">{title}</h3>
            <p className="text-xs text-text-secondary mt-1">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onKeepEditing}
            disabled={isSaving}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
          >
            {keepEditingLabel ?? t('unsavedDialog.keepEditing')}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={isSaving}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
          >
            {discardLabel ?? t('unsavedDialog.discard')}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('unsavedDialog.saving')}
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                {saveLabel ?? t('unsavedDialog.saveChanges')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
