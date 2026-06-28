import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Plus, RefreshCw, AlertTriangle, Loader2, Trash2, Pencil, Users, Activity } from 'lucide-react';
import { useBotStore, type Bot as BotType } from '../stores/bot-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { Button } from './ui/button';
import BotForm from './BotForm';
import BotMemberList from './BotMemberList';

export default function BotManagementPage() {
  const { t } = useTranslation('settings');
  const {
    bots,
    membersByBotId,
    statusByBotId,
    isLoading,
    isSaving,
    error,
    fetchBots,
    createBot,
    updateBot,
    deleteBot,
    switchWorkspace,
    fetchMembers,
    addMember,
    setMemberRole,
    removeMember,
    fetchStatus,
    clearError,
  } = useBotStore();
  const { workspaces, fetchWorkspaces } = useWorkspaceStore();

  const [editingBot, setEditingBot] = useState<BotType | null | undefined>(undefined);
  const [selectedBot, setSelectedBot] = useState<BotType | null>(null);
  const [view, setView] = useState<'list' | 'form' | 'members'>('list');

  useEffect(() => {
    void fetchBots();
    void fetchWorkspaces();
  }, [fetchBots, fetchWorkspaces]);

  useEffect(() => {
    if (selectedBot) {
      void fetchMembers(selectedBot.id);
      void fetchStatus(selectedBot.id);
    }
  }, [selectedBot, fetchMembers, fetchStatus]);

  const handleCreate = async (input: Parameters<typeof createBot>[0]) => {
    const bot = await createBot(input);
    if (bot) {
      setView('list');
      setEditingBot(undefined);
    }
  };

  const handleUpdate = async (input: Parameters<typeof updateBot>[1]) => {
    if (!editingBot) return;
    const bot = await updateBot(editingBot.id, input);
    if (bot) {
      setView('list');
      setEditingBot(undefined);
      if (selectedBot?.id === bot.id) {
        setSelectedBot(bot);
      }
    }
  };

  const handleDelete = async (bot: BotType) => {
    if (!confirm(t('bots.deleteConfirm', { name: bot.name }))) return;
    const ok = await deleteBot(bot.id);
    if (ok && selectedBot?.id === bot.id) {
      setSelectedBot(null);
    }
  };

  const handleSwitchWorkspace = async (botId: string, workspaceId: string) => {
    const bot = await switchWorkspace(botId, workspaceId);
    if (bot && selectedBot?.id === bot.id) {
      setSelectedBot(bot);
    }
  };

  if (view === 'form') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => { setView('list'); setEditingBot(undefined); }} className="text-text-secondary">
            ← {t('bots.backToList')}
          </Button>
        </div>
        <BotForm
          bot={editingBot}
          workspaces={workspaces}
          isSaving={isSaving}
          error={error}
          onSubmit={editingBot ? handleUpdate : handleCreate}
          onCancel={() => { setView('list'); setEditingBot(undefined); }}
        />
      </div>
    );
  }

  if (view === 'members' && selectedBot) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => setView('list')} className="text-text-secondary">
            ← {t('bots.backToList')}
          </Button>
        </div>

        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Users className="w-4 h-4" />
              {t('bots.membersOf', { name: selectedBot.name })}
            </h3>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => fetchMembers(selectedBot.id)} className="text-text-tertiary">
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          <BotMemberList
            botId={selectedBot.id}
            members={membersByBotId[selectedBot.id] || []}
            isLoading={isLoading}
            isSaving={isSaving}
            error={error}
            onAddMember={(input) => addMember(selectedBot.id, input)}
            onSetRole={(provider, providerUserId, role) =>
              setMemberRole(selectedBot.id, provider, providerUserId, role)
            }
            onRemoveMember={(provider, providerUserId) =>
              removeMember(selectedBot.id, provider, providerUserId)
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">{t('bots.title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => fetchBots()} className="text-text-tertiary">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => { setEditingBot(null); setView('form'); }} className="gap-1">
            <Plus className="w-3.5 h-3.5" />
            {t('bots.create')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{error}</p>
          <button onClick={clearError} className="text-[10px] text-destructive underline ml-auto">{t('actions.dismiss')}</button>
        </div>
      )}

      {isLoading && bots.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-text-tertiary" />
        </div>
      )}

      {!isLoading && bots.length === 0 && (
        <div className="text-center py-12 border border-dashed border-border rounded-lg">
          <Bot className="w-10 h-10 text-text-tertiary mx-auto mb-3" />
          <p className="text-sm text-text-secondary mb-1">{t('bots.emptyTitle')}</p>
          <p className="text-xs text-text-tertiary mb-4">{t('bots.emptyDescription')}</p>
          <Button size="sm" onClick={() => { setEditingBot(null); setView('form'); }}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {t('bots.create')}
          </Button>
        </div>
      )}

      {bots.length > 0 && (
        <div className="border border-border rounded-lg divide-y divide-border/50">
          {bots.map((bot) => {
            const status = statusByBotId[bot.id];
            const activeWorkspace = workspaces.find((w) => w.id === bot.activeWorkspaceId);
            return (
              <div key={bot.id} className="p-4 hover:bg-surface-hover/50 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text-primary truncate">{bot.name}</span>
                      {bot.providerSettings.wecom?.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">WeCom</span>
                      )}
                      {bot.providerSettings.feishu?.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">Feishu</span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-tertiary mb-2">
                      {activeWorkspace
                        ? t('bots.activeWorkspaceLabel', { name: activeWorkspace.name })
                        : t('bots.noActiveWorkspace')}
                    </p>

                    <div className="flex items-center gap-3">
                      <select
                        value={bot.activeWorkspaceId || ''}
                        onChange={(e) => handleSwitchWorkspace(bot.id, e.target.value)}
                        disabled={isSaving}
                        className="text-xs px-2 py-1 bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary disabled:opacity-50"
                      >
                        <option value="">{t('bots.selectWorkspace')}</option>
                        {workspaces.map((ws) => (
                          <option key={ws.id} value={ws.id}>{ws.name}</option>
                        ))}
                      </select>
                      {status && (
                        <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
                          <Activity className="w-3 h-3" />
                          <span>{status.wecom || '—'}</span>
                          <span className="text-border">/</span>
                          <span>{status.feishu || '—'}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setSelectedBot(bot); setView('members'); }}
                      className="text-text-tertiary"
                      title={t('bots.manageMembers')}
                    >
                      <Users className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditingBot(bot); setView('form'); }}
                      className="text-text-tertiary"
                      title={t('bots.edit')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(bot)}
                      className="text-text-tertiary hover:text-destructive"
                      title={t('bots.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
