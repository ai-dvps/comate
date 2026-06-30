import { useTranslation } from 'react-i18next';
import { Plus, Bot } from 'lucide-react';
import type { Bot as BotType } from '../stores/bot-store';

export interface BotSection {
  id: string;
  label: string;
}

interface BotTabShellProps {
  bots: BotType[];
  selectedBotId: string | null;
  onSelectBot: (id: string) => void;
  onCreateBot: () => void;
  sections: BotSection[];
  activeSection: string;
  onSelectSection: (id: string) => void;
  footer?: React.ReactNode;
  emptyState: React.ReactNode;
  children: React.ReactNode;
}

export default function BotTabShell({
  bots,
  selectedBotId,
  onSelectBot,
  onCreateBot,
  sections,
  activeSection,
  onSelectSection,
  footer,
  emptyState,
  children,
}: BotTabShellProps) {
  const { t } = useTranslation('settings');

  const isEmpty = bots.length === 0;

  return (
    <div className="flex h-full">
      {/* Left column: bot list */}
      <div className="w-64 border-r border-border/50 flex-shrink-0 overflow-y-auto">
        <div className="p-3">
          <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-2 px-2">
            {t('bots.title')}
          </p>
          <div className="space-y-0.5">
            {bots.map((bot) => (
              <button
                key={bot.id}
                onClick={() => onSelectBot(bot.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  selectedBotId === bot.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                <span className="block truncate">{bot.name}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onCreateBot}
            className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-[11px] font-medium text-text-secondary hover:text-text-primary border border-dashed border-border hover:border-border/80 hover:bg-surface-hover transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('bots.create')}
          </button>
        </div>
      </div>

      {/* Right column: settings content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {isEmpty ? (
          <div className="flex-1 overflow-y-auto p-6">{emptyState}</div>
        ) : (
          <>
            {/* Section tabs */}
            <div className="flex border-b border-border/50 flex-shrink-0 px-6">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => onSelectSection(section.id)}
                  className={`py-2 px-3 text-[11px] font-medium transition-all ${
                    activeSection === section.id
                      ? 'text-text-primary border-b-2 border-accent'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {section.label}
                </button>
              ))}
            </div>

            {/* Section content */}
            <div className="flex-1 overflow-y-auto p-6">{children}</div>

            {/* Footer */}
            {footer && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-border/50 flex-shrink-0">
                {footer}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function BotEmptyState({ onCreateBot }: { onCreateBot: () => void }) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center py-12 border border-dashed border-border rounded-lg px-8 max-w-md">
        <Bot className="w-10 h-10 text-text-tertiary mx-auto mb-3" />
        <p className="text-sm text-text-secondary mb-1">{t('bots.emptyTitle')}</p>
        <p className="text-xs text-text-tertiary mb-4">{t('bots.emptyDescription')}</p>
        <button
          type="button"
          onClick={onCreateBot}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('bots.create')}
        </button>
      </div>
    </div>
  );
}
