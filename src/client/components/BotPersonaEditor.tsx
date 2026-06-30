import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Check, Loader2, AlertTriangle, Sparkles } from 'lucide-react';
import type { Bot, BotPersona } from '../stores/bot-store';
import { cn } from './ui/utils';

interface BotPersonaEditorProps {
  bot: Bot;
  isSaving?: boolean;
  error?: string | null;
  onSave: (persona: BotPersona | null) => void | Promise<void>;
}

const PERSONA_BUDGET = 2000;

export default function BotPersonaEditor({
  bot,
  isSaving,
  error,
  onSave,
}: BotPersonaEditorProps) {
  const { t } = useTranslation('settings');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [savedMode, setSavedMode] = useState<'append' | 'replace'>('append');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const initialPrompt = bot.persona?.prompt ?? '';
    const initialMode = bot.persona?.mode ?? 'append';
    setPrompt(initialPrompt);
    setMode(initialMode);
    setSavedPrompt(initialPrompt);
    setSavedMode(initialMode);
    setSaveError(null);
  }, [bot]);

  const trimmedPrompt = prompt.trim();
  const isDirty = trimmedPrompt !== savedPrompt.trim() || mode !== savedMode;

  const handleSave = async () => {
    setSaveError(null);
    const persona: BotPersona | null = trimmedPrompt
      ? { prompt: trimmedPrompt, mode }
      : null;
    try {
      await onSave(persona);
      setSavedPrompt(trimmedPrompt);
      setSavedMode(mode);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-text-secondary" />
        <h4 className="text-xs font-medium text-text-secondary">{t('bots.persona.title')}</h4>
      </div>

      <p className="text-[10px] text-text-tertiary">{t('bots.persona.description')}</p>

      {(error || saveError) && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{saveError || error}</p>
        </div>
      )}

      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">
          {t('bots.persona.promptLabel')}
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('bots.persona.promptPlaceholder')}
          rows={8}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
        />
        {prompt.length > PERSONA_BUDGET && (
          <p className="text-[10px] text-warning mt-1">{t('bots.persona.lengthWarning')}</p>
        )}
      </div>

      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-2">
          {t('bots.persona.modeLabel')}
        </label>
        <div className="flex gap-2 p-1 bg-surface-hover rounded-lg">
          <button
            type="button"
            onClick={() => setMode('append')}
            className={cn(
              'flex-1 px-3 py-1.5 text-[11px] font-medium rounded transition-colors',
              mode === 'append'
                ? 'bg-surface-active text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t('bots.persona.modeAppend')}
          </button>
          <button
            type="button"
            onClick={() => setMode('replace')}
            className={cn(
              'flex-1 px-3 py-1.5 text-[11px] font-medium rounded transition-colors',
              mode === 'replace'
                ? 'bg-surface-active text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t('bots.persona.modeReplace')}
          </button>
        </div>
        <p className="text-[10px] text-text-tertiary mt-1">
          {mode === 'append'
            ? t('bots.persona.modeAppendHint')
            : t('bots.persona.modeReplaceHint')}
        </p>
      </div>

      <p className="text-[10px] text-text-tertiary">{t('bots.persona.freezeHint')}</p>

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
            isDirty
              ? 'bg-accent hover:bg-accent-hover text-accent-foreground'
              : 'bg-surface-active text-text-secondary',
          )}
        >
          {isSaving ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('actions.saving')}
            </>
          ) : isDirty ? (
            <>
              <Save className="w-3.5 h-3.5" />
              {t('bots.persona.saveChanges')}
            </>
          ) : (
            <>
              <Check className="w-3.5 h-3.5" />
              {t('bots.persona.saved')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
