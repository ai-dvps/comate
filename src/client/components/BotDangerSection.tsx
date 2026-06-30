import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';

interface BotDangerSectionProps {
  botName: string;
  onDelete: () => void | Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

export default function BotDangerSection({ botName, onDelete, isLoading, error }: BotDangerSectionProps) {
  const { t } = useTranslation('settings');
  const [showDialog, setShowDialog] = useState(false);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (!showDialog) {
      setInputValue('');
    }
  }, [showDialog]);

  useEffect(() => {
    if (!showDialog) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowDialog(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDialog]);

  const normalizedInput = inputValue.trim();
  const normalizedName = botName.trim();
  const canConfirm = normalizedInput === normalizedName && !isLoading;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    await onDelete();
    setShowDialog(false);
  };

  return (
    <div className="max-w-xl">
      <div className="border border-destructive/20 rounded-lg p-4 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-xs font-medium text-text-secondary">{t('bots.danger.deleteTitle')}</h4>
            <p className="text-[10px] text-text-tertiary mt-1">{t('bots.danger.deleteDescription')}</p>
          </div>
        </div>

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setShowDialog(true)}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-destructive hover:bg-destructive/90 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('bots.delete')}
          </button>
        </div>
      </div>

      {showDialog && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed top-11 inset-x-0 bottom-0 z-[60] flex items-start justify-center pt-16"
        >
          <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={() => setShowDialog(false)} />
          <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col mx-4">
            <div className="px-5 py-4 border-b border-border/50 flex-shrink-0">
              <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                {t('bots.danger.deleteTitle')}
              </h2>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div className="text-xs text-text-secondary space-y-2">
                <p>{t('bots.danger.confirmWarning', { botName })}</p>
                <p className="text-text-tertiary">{t('bots.danger.sessionsRemain')}</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  {t('bots.danger.inputLabel')}
                </label>
                <input
                  autoFocus
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={t('bots.danger.inputPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-destructive text-text-primary placeholder:text-text-tertiary"
                />
                {normalizedInput.length > 0 && normalizedInput !== normalizedName && (
                  <p className="text-xs text-destructive mt-1.5">{t('bots.danger.nameMismatch')}</p>
                )}
                {error && <p className="text-xs text-destructive mt-1.5">{error}</p>}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowDialog(false)}
                disabled={isLoading}
                className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
              >
                {t('actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!canConfirm}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-destructive hover:bg-destructive/90 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('bots.danger.deleting')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('bots.delete')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
