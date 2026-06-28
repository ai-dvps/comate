import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, UserPlus, AlertTriangle, Loader2 } from 'lucide-react';
import type { BotMember, BotProvider, BotRole } from '../stores/bot-store';

interface BotMemberListProps {
  botId: string;
  members: BotMember[];
  isLoading?: boolean;
  isSaving?: boolean;
  error?: string | null;
  onAddMember: (input: { provider: BotProvider; providerUserId: string; role: BotRole }) => Promise<unknown>;
  onSetRole: (provider: BotProvider, providerUserId: string, role: BotRole) => Promise<unknown>;
  onRemoveMember: (provider: BotProvider, providerUserId: string) => Promise<unknown>;
}

export default function BotMemberList({
  botId,
  members,
  isLoading,
  isSaving,
  error,
  onAddMember,
  onSetRole,
  onRemoveMember,
}: BotMemberListProps) {
  const { t } = useTranslation('settings');
  const [provider, setProvider] = useState<BotProvider>('wecom');
  const [providerUserId, setProviderUserId] = useState('');
  const [role, setRole] = useState<BotRole>('normal');
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    setProviderUserId('');
    setFormError(null);
  }, [botId]);

  const handleAdd = async () => {
    setFormError(null);
    const trimmed = providerUserId.trim();
    if (!trimmed) {
      setFormError(t('bots.memberUserIdRequired'));
      return;
    }
    await onAddMember({ provider, providerUserId: trimmed, role });
    setProviderUserId('');
    setRole('normal');
  };

  const handleRemove = async (member: BotMember) => {
    const key = `${member.provider}:${member.providerUserId}`;
    setRemoving(key);
    await onRemoveMember(member.provider, member.providerUserId);
    setRemoving(null);
  };

  const sortedMembers = [...members].sort((a, b) => {
    const roleOrder = { owner: 0, admin: 1, normal: 2 };
    if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
    return a.providerUserId.localeCompare(b.providerUserId);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-text-secondary">{t('bots.membersTitle')}</h4>
        <span className="text-[10px] text-text-tertiary">
          {t('bots.memberCount', { count: members.length })}
        </span>
      </div>

      {(error || formError) && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{formError || error}</p>
        </div>
      )}

      <div className="border border-border rounded-lg p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as BotProvider)}
            className="px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
          >
            <option value="wecom">{t('bots.providerWecom')}</option>
            <option value="feishu">{t('bots.providerFeishu')}</option>
          </select>
          <input
            value={providerUserId}
            onChange={(e) => setProviderUserId(e.target.value)}
            placeholder={t('bots.memberUserIdPlaceholder')}
            className="sm:col-span-2 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as BotRole)}
            className="px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary"
          >
            <option value="normal">{t('bots.roleNormal')}</option>
            <option value="admin">{t('bots.roleAdmin')}</option>
            <option value="owner">{t('bots.roleOwner')}</option>
          </select>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
        >
          {isSaving ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <UserPlus className="w-3 h-3" />
          )}
          {t('bots.addMember')}
        </button>
      </div>

      {isLoading && members.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
        </div>
      )}

      {!isLoading && sortedMembers.length === 0 && (
        <div className="text-center py-6 border border-dashed border-border rounded-lg">
          <UserPlus className="w-6 h-6 text-text-tertiary mx-auto mb-1.5" />
          <p className="text-xs text-text-secondary">{t('bots.noMembers')}</p>
        </div>
      )}

      {sortedMembers.length > 0 && (
        <div className="border border-border rounded-lg divide-y divide-border/50">
          {sortedMembers.map((member) => {
            const key = `${member.provider}:${member.providerUserId}`;
            return (
              <div key={key} className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary">
                    {member.provider}
                  </span>
                  <span className="text-xs text-text-primary font-mono">{member.providerUserId}</span>
                  <select
                    value={member.role}
                    onChange={(e) =>
                      onSetRole(member.provider, member.providerUserId, e.target.value as BotRole)
                    }
                    disabled={isSaving}
                    className="text-xs px-2 py-1 bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary disabled:opacity-50"
                  >
                    <option value="normal">{t('bots.roleNormal')}</option>
                    <option value="admin">{t('bots.roleAdmin')}</option>
                    <option value="owner">{t('bots.roleOwner')}</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(member)}
                  disabled={removing === key || isSaving}
                  className="p-1.5 rounded-md text-text-tertiary hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  {removing === key ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
