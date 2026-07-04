import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, UserPlus, AlertTriangle, Loader2, Crown, RefreshCw, Check, XCircle } from 'lucide-react';
import type { BotMember, BotChannel, BotRole } from '../stores/bot-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface BotMemberListProps {
  botId: string;
  members: BotMember[];
  isLoading?: boolean;
  isSaving?: boolean;
  error?: string | null;
  onAddMember: (input: { channel: BotChannel; channelUserId: string; role: BotRole }) => Promise<unknown>;
  onSetRole: (channel: BotChannel, channelUserId: string, role: BotRole) => Promise<unknown>;
  onRemoveMember: (channel: BotChannel, channelUserId: string) => Promise<unknown>;
  onRefreshMembers: () => Promise<unknown>;
  onResolvePending: () => Promise<unknown>;
  onSetPlaintext: (channel: BotChannel, channelUserId: string, plaintextUserId: string) => Promise<unknown>;
}

const CHANNELS: BotChannel[] = ['wecom', 'feishu'];

export default function BotMemberList({
  botId,
  members,
  isLoading,
  isSaving,
  error,
  onAddMember,
  onSetRole,
  onRemoveMember,
  onRefreshMembers,
  onResolvePending,
  onSetPlaintext,
}: BotMemberListProps) {
  const { t } = useTranslation('settings');
  const [channel, setChannel] = useState<BotChannel>('wecom');
  const [channelUserId, setChannelUserId] = useState('');
  const [role, setRole] = useState<BotRole>('normal');
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null);
  const [editingPlaintext, setEditingPlaintext] = useState<Record<string, string>>({});
  const [savingPlaintextKey, setSavingPlaintextKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    setChannelUserId('');
    setFormError(null);
    setConfirmRemoveKey(null);
    setEditingPlaintext({});
    setSavingPlaintextKey(null);
  }, [botId]);

  const channelHasOwner = (c: BotChannel) =>
    members.some((m) => m.channel === c && m.role === 'owner');

  const channelOwnerCount = (c: BotChannel) =>
    members.filter((m) => m.channel === c && m.role === 'owner').length;

  const handleAdd = async () => {
    setFormError(null);
    const trimmed = channelUserId.trim();
    if (!trimmed) {
      setFormError(t('bots.memberUserIdRequired'));
      return;
    }
    if (role === 'owner' && channelHasOwner(channel)) {
      setFormError(t('bots.ownerAlreadyExists'));
      return;
    }
    await onAddMember({ channel, channelUserId: trimmed, role });
    setChannelUserId('');
    setRole('normal');
  };

  const handleRemove = async (member: BotMember) => {
    const key = `${member.channel}:${member.channelUserId}`;
    if (member.role === 'owner' && channelOwnerCount(member.channel) <= 1) {
      setConfirmRemoveKey(key);
      return;
    }
    setRemoving(key);
    setConfirmRemoveKey(null);
    await onRemoveMember(member.channel, member.channelUserId);
    setRemoving(null);
  };

  const handleConfirmRemove = async (member: BotMember) => {
    const key = `${member.channel}:${member.channelUserId}`;
    setRemoving(key);
    setConfirmRemoveKey(null);
    await onRemoveMember(member.channel, member.channelUserId);
    setRemoving(null);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshMembers();
    } finally {
      setRefreshing(false);
    }
  };

  const handleResolvePending = async () => {
    setResolving(true);
    try {
      await onResolvePending();
    } finally {
      setResolving(false);
    }
  };

  const handlePlaintextChange = (key: string, value: string) => {
    setEditingPlaintext((prev) => ({ ...prev, [key]: value }));
  };

  const handlePlaintextSave = async (member: BotMember) => {
    const key = `${member.channel}:${member.channelUserId}`;
    const value = editingPlaintext[key]?.trim() ?? '';
    if (!value) {
      setFormError(t('bots.plaintextUserIdRequired'));
      return;
    }
    setSavingPlaintextKey(key);
    setFormError(null);
    try {
      await onSetPlaintext(member.channel, member.channelUserId, value);
      setEditingPlaintext((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } finally {
      setSavingPlaintextKey(null);
    }
  };

  const handlePlaintextCancel = (member: BotMember) => {
    const key = `${member.channel}:${member.channelUserId}`;
    setEditingPlaintext((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const groupedMembers = CHANNELS.map((c) => ({
    channel: c,
    items: members.filter((m) => m.channel === c).sort((a, b) => {
      const roleOrder = { owner: 0, admin: 1, normal: 2 };
      if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
      return a.channelUserId.localeCompare(b.channelUserId);
    }),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-text-secondary">{t('bots.membersTitle')}</h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResolvePending}
            disabled={resolving || isSaving}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
          >
            {resolving ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {t('bots.resolvePending')}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || isLoading}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
            title={t('bots.refreshMembers')}
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
          <span className="text-[10px] text-text-tertiary">
            {t('bots.memberCount', { count: members.length })}
          </span>
        </div>
      </div>

      {(error || formError) && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{formError || error}</p>
        </div>
      )}

      <div className="border border-border rounded-lg p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <Select value={channel} onValueChange={(value) => setChannel(value as BotChannel)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="wecom">{t('bots.channelWecom')}</SelectItem>
              <SelectItem value="feishu">{t('bots.channelFeishu')}</SelectItem>
            </SelectContent>
          </Select>
          <input
            value={channelUserId}
            onChange={(e) => setChannelUserId(e.target.value)}
            placeholder={t('bots.memberUserIdPlaceholder')}
            className="sm:col-span-2 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <Select value={role} onValueChange={(value) => setRole(value as BotRole)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">{t('bots.roleNormal')}</SelectItem>
              <SelectItem value="admin">{t('bots.roleAdmin')}</SelectItem>
              <SelectItem value="owner" disabled={channelHasOwner(channel)}>
                {t('bots.roleOwner')}
              </SelectItem>
            </SelectContent>
          </Select>
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

      {!isLoading && members.length === 0 && (
        <div className="text-center py-6 border border-dashed border-border rounded-lg">
          <UserPlus className="w-6 h-6 text-text-tertiary mx-auto mb-1.5" />
          <p className="text-xs text-text-secondary">{t('bots.noMembers')}</p>
        </div>
      )}

      {groupedMembers.map(({ channel: groupChannel, items }) => {
        const hasOwner = channelHasOwner(groupChannel);
        return (
          <div key={groupChannel} className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-surface-hover border-b border-border/50">
              <span className="text-xs font-medium text-text-secondary">
                {t(`bots.channel${groupChannel.charAt(0).toUpperCase() + groupChannel.slice(1)}` as const)}
              </span>
              {hasOwner ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-text-tertiary">
                  <Crown className="w-3 h-3 text-warning" />
                  {t('bots.ownerAssigned')}
                </span>
              ) : items.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                  <AlertTriangle className="w-3 h-3" />
                  {t('bots.ownerlessChannel')}
                </span>
              ) : null}
            </div>

            {items.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-text-tertiary">{t('bots.noMembersInChannel')}</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {items.map((member) => {
                  const key = `${member.channel}:${member.channelUserId}`;
                  const isConfirming = confirmRemoveKey === key;
                  const isPending = member.resolutionStatus === 'pending';
                  const plaintextValue = editingPlaintext[key] ?? member.plaintextUserId ?? '';
                  const isEditingPlaintext = key in editingPlaintext || isPending;
                  return (
                    <div key={key} className="px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col gap-1.5 min-w-0">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary">
                              {member.channel}
                            </span>
                            <span className="text-xs text-text-primary font-mono">{member.channelUserId}</span>
                            {member.role === 'owner' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-warning">
                                <Crown className="w-3 h-3" />
                                {t('bots.roleOwner')}
                              </span>
                            ) : (
                              <Select
                                value={member.role}
                                onValueChange={(value) =>
                                  onSetRole(member.channel, member.channelUserId, value as BotRole)
                                }
                                disabled={isSaving}
                              >
                                <SelectTrigger className="w-auto min-w-[80px] text-xs py-1 px-2 h-auto">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="normal">{t('bots.roleNormal')}</SelectItem>
                                  <SelectItem value="admin">{t('bots.roleAdmin')}</SelectItem>
                                  <SelectItem value="owner" disabled={channelHasOwner(member.channel)}>
                                    {t('bots.roleOwner')}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded ${
                                isPending
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-success/10 text-success'
                              }`}
                            >
                              {isPending ? t('bots.pending') : t('bots.resolved')}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            {isEditingPlaintext ? (
                              <>
                                <input
                                  value={plaintextValue}
                                  onChange={(e) => handlePlaintextChange(key, e.target.value)}
                                  placeholder={t('bots.plaintextUserIdPlaceholder')}
                                  disabled={savingPlaintextKey === key || isSaving}
                                  className="min-w-[120px] px-2 py-1 text-xs bg-bg border border-border rounded focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                                />
                                <button
                                  type="button"
                                  onClick={() => handlePlaintextSave(member)}
                                  disabled={savingPlaintextKey === key || isSaving}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-md transition-colors"
                                >
                                  {savingPlaintextKey === key ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Check className="w-3 h-3" />
                                  )}
                                  {t('actions.save')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handlePlaintextCancel(member)}
                                  disabled={savingPlaintextKey === key}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-md transition-colors"
                                >
                                  <XCircle className="w-3 h-3" />
                                  {t('actions.cancel')}
                                </button>
                              </>
                            ) : (
                              <>
                                {member.plaintextUserId && (
                                  <span className="text-[11px] font-mono text-text-secondary">
                                    {member.plaintextUserId}
                                  </span>
                                )}
                                {member.displayName && (
                                  <span className="text-[11px] text-text-secondary">
                                    ({member.displayName})
                                  </span>
                                )}
                              </>
                            )}
                          </div>
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

                      {isConfirming && (
                        <div className="mt-2 p-2 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center justify-between gap-2">
                          <p className="text-[11px] text-destructive">{t('bots.lastOwnerRemoveWarning')}</p>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveKey(null)}
                              className="px-2 py-1 text-[10px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-md transition-colors"
                            >
                              {t('actions.cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleConfirmRemove(member)}
                              className="px-2 py-1 text-[10px] font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-md transition-colors"
                            >
                              {t('actions.confirm')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
