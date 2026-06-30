import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Check, Loader2, AlertTriangle, Sparkles, X } from 'lucide-react';
import type { Bot, BotPersona, BotRole } from '../stores/bot-store';
import { cn } from './ui/utils';

export interface BotPersonaEditorHandle {
  save: () => Promise<void>;
  isDirty: () => boolean;
}

interface BotPersonaEditorProps {
  bot: Bot;
  isSaving?: boolean;
  error?: string | null;
  onSave: (payload: { persona: BotPersona | null; rolePersonas: Partial<Record<BotRole, BotPersona>> }) => void | Promise<void>;
  onDirtyChange?: (isDirty: boolean) => void;
}

type PersonaTab = 'default' | BotRole;

const PERSONA_BUDGET = 2000;
const ROLE_ORDER: BotRole[] = ['owner', 'admin', 'normal'];
const TABS: PersonaTab[] = ['default', ...ROLE_ORDER];

function emptyPersona(): BotPersona {
  return { prompt: '', mode: 'append' };
}

function botToRecord(bot: Bot): Record<PersonaTab, BotPersona> {
  return {
    default: bot.persona ?? emptyPersona(),
    owner: bot.rolePersonas?.owner ?? emptyPersona(),
    admin: bot.rolePersonas?.admin ?? emptyPersona(),
    normal: bot.rolePersonas?.normal ?? emptyPersona(),
  };
}

function trimRecord(record: Record<PersonaTab, BotPersona>): Record<PersonaTab, BotPersona> {
  return Object.fromEntries(
    TABS.map((tab) => [tab, { ...record[tab], prompt: record[tab].prompt.trim() }]),
  ) as Record<PersonaTab, BotPersona>;
}

function isRecordDirty(
  draft: Record<PersonaTab, BotPersona>,
  saved: Record<PersonaTab, BotPersona>,
): boolean {
  return TABS.some(
    (tab) => draft[tab].prompt.trim() !== saved[tab].prompt.trim() || draft[tab].mode !== saved[tab].mode,
  );
}

function hasOverBudgetPrompt(record: Record<PersonaTab, BotPersona>): Record<PersonaTab, boolean> {
  return Object.fromEntries(
    TABS.map((tab) => [tab, record[tab].prompt.length > PERSONA_BUDGET]),
  ) as Record<PersonaTab, boolean>;
}

const BotPersonaEditor = forwardRef<BotPersonaEditorHandle, BotPersonaEditorProps>(
  ({ bot, isSaving, error, onSave, onDirtyChange }, ref) => {
    const { t } = useTranslation('settings');
    const [activeTab, setActiveTab] = useState<PersonaTab>('default');
    const [draft, setDraft] = useState<Record<PersonaTab, BotPersona>>(() => botToRecord(bot));
    const [saved, setSaved] = useState<Record<PersonaTab, BotPersona>>(() => botToRecord(bot));
    const [saveError, setSaveError] = useState<string | null>(null);
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
      const record = botToRecord(bot);
      setDraft(record);
      setSaved(record);
      setSaveError(null);
    }, [bot]);

    useEffect(() => {
      const idx = TABS.indexOf(activeTab);
      tabRefs.current[idx]?.focus();
    }, [activeTab]);

    const overBudget = hasOverBudgetPrompt(draft);
    const isDirty = isRecordDirty(draft, saved);

    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;

    useEffect(() => {
      onDirtyChangeRef.current?.(isDirty);
    }, [isDirty]);

    useImperativeHandle(ref, () => ({
      save: async () => {
        await handleSave();
      },
      isDirty: () => isRecordDirty(draft, saved),
    }));

    const updateTab = (tab: PersonaTab, patch: Partial<BotPersona>) => {
      setDraft((prev) => ({
        ...prev,
        [tab]: { ...prev[tab], ...patch },
      }));
    };

    const handleSave = async () => {
      setSaveError(null);
      const trimmed = trimRecord(draft);
      const defaultPrompt = trimmed.default.prompt;
      const persona: BotPersona | null = defaultPrompt
        ? { prompt: defaultPrompt, mode: trimmed.default.mode }
        : null;
      const rolePersonas: Partial<Record<BotRole, BotPersona>> = {};
      for (const role of ROLE_ORDER) {
        if (trimmed[role].prompt) {
          rolePersonas[role] = { prompt: trimmed[role].prompt, mode: trimmed[role].mode };
        }
      }
      try {
        await onSave({ persona, rolePersonas });
        setSaved(trimmed);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    };

    const handleCancel = () => {
      setDraft(saved);
      setSaveError(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const nextIndex = e.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : (index - 1 + TABS.length) % TABS.length;
      setActiveTab(TABS[nextIndex]);
    };

    const activePrompt = draft[activeTab].prompt;
    const activeMode = draft[activeTab].mode;
    const showFallbackHint =
      activeTab !== 'default' &&
      !saved[activeTab].prompt.trim() &&
      !draft[activeTab].prompt.trim();

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

        <div
          role="tablist"
          aria-label={t('bots.persona.title')}
          className="flex gap-1 p-1 bg-surface-hover rounded-lg"
        >
          {TABS.map((tab, index) => {
            const label = t(`bots.persona.${tab}Tab`);
            return (
              <button
                key={tab}
                ref={(el) => { tabRefs.current[index] = el; }}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded transition-colors',
                  activeTab === tab
                    ? 'bg-surface-active text-text-primary'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {label}
                {overBudget[tab] && (
                  <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        <div className="p-3 bg-surface-hover/50 border border-border rounded-lg">
          <p className="text-[10px] text-text-secondary">
            {activeTab === 'default'
              ? t('bots.persona.defaultDescription')
              : t(`bots.persona.${activeTab}Description`)}
          </p>
        </div>

        {showFallbackHint && (
          <div className="p-3 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-warning">{t('bots.persona.fallbackHint')}</p>
          </div>
        )}

        <div>
          <label className="block text-[11px] font-medium text-text-tertiary mb-1">
            {t('bots.persona.promptLabel')}
          </label>
          <textarea
            value={activePrompt}
            onChange={(e) => updateTab(activeTab, { prompt: e.target.value })}
            placeholder={t('bots.persona.promptPlaceholder')}
            rows={8}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
          />
          {overBudget[activeTab] && (
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
              onClick={() => updateTab(activeTab, { mode: 'append' })}
              className={cn(
                'flex-1 px-3 py-1.5 text-[11px] font-medium rounded transition-colors',
                activeMode === 'append'
                  ? 'bg-surface-active text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {t('bots.persona.modeAppend')}
            </button>
            <button
              type="button"
              onClick={() => updateTab(activeTab, { mode: 'replace' })}
              className={cn(
                'flex-1 px-3 py-1.5 text-[11px] font-medium rounded transition-colors',
                activeMode === 'replace'
                  ? 'bg-surface-active text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {t('bots.persona.modeReplace')}
            </button>
          </div>
          <p className="text-[10px] text-text-tertiary mt-1">
            {activeMode === 'append'
              ? t('bots.persona.modeAppendHint')
              : t('bots.persona.modeReplaceHint')}
          </p>
        </div>

        <p className="text-[10px] text-text-tertiary">{t('bots.persona.freezeHint')}</p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSaving || !isDirty}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-text-secondary hover:text-text-primary hover:bg-surface-hover"
          >
            <X className="w-3.5 h-3.5" />
            {t('bots.persona.cancel')}
          </button>
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
                {t('bots.persona.saveAll')}
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
  },
);

BotPersonaEditor.displayName = 'BotPersonaEditor';

export default BotPersonaEditor;
