import {
  useEffect,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useMemo,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, Save } from 'lucide-react';
import { useBotStore, type Bot as BotType, type BotPersona, type BotRole } from '../stores/bot-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import BotTabShell, { BotEmptyState } from './BotTabShell';
import BotGeneralSection from './BotGeneralSection';
import BotChannelsSection from './BotChannelsSection';
import BotUserList from './BotUserList';
import BotRolePermissions, { type BotRolePermissionsHandle } from './BotRolePermissions';
import BotPersonaEditor, { type BotPersonaEditorHandle } from './BotPersonaEditor';
import BotDangerSection from './BotDangerSection';
import { emptyForm, botToForm, validateBotForm, buildCreateBotInput, buildUpdateBotInput, type BotFormData } from './bot-form-utils';
import { filterBotsByName } from '../lib/bot-filter';

function deriveChannelPendingAction(
  pre: BotFormData | undefined,
  post: BotFormData | undefined,
  channel: 'wecom' | 'feishu',
): 'connect' | 'disconnect' | null {
  if (!pre || !post) return null;
  const enabledKey = channel === 'wecom' ? 'wecomEnabled' : 'feishuEnabled';
  const wasEnabled = pre[enabledKey];
  const isEnabled = post[enabledKey];
  if (wasEnabled && !isEnabled) return 'disconnect';
  if (!wasEnabled && isEnabled) return 'connect';
  if (!isEnabled) return null;

  if (channel === 'wecom') {
    const credsChanged =
      pre.wecomBotId !== post.wecomBotId ||
      pre.wecomBotSecret !== post.wecomBotSecret ||
      pre.wecomCorpId !== post.wecomCorpId ||
      pre.wecomCorpSecret !== post.wecomCorpSecret;
    return credsChanged ? 'connect' : null;
  }

  const credsChanged =
    pre.feishuAppId !== post.feishuAppId ||
    pre.feishuAppSecret !== post.feishuAppSecret ||
    pre.feishuEncryptKey !== post.feishuEncryptKey ||
    pre.feishuVerificationToken !== post.feishuVerificationToken;
  return credsChanged ? 'connect' : null;
}

export type BotSectionId = 'general' | 'channels' | 'members' | 'roles' | 'persona' | 'danger';

export interface BotManagementPageHandle {
  isDirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
}

interface BotManagementPageProps {}

const BotManagementPage = forwardRef<BotManagementPageHandle, BotManagementPageProps>(
  function BotManagementPage(_props, ref) {
    const { t } = useTranslation('settings');
    const {
      bots: storeBots,
      membersByBotId,
      channelStatusByBotId,
      isLoading,
      error: storeError,
      fetchBots,
      createBot,
      updateBot,
      deleteBot,
      fetchMembers,
      addMember,
      setMemberRole,
      removeMember,
      resolvePendingMembers,
      setMemberPlaintext,
      refreshMembers,
      fetchStatus,
      reconnectChannel,
      clearError,
    } = useBotStore();
    const { workspaces, fetchWorkspaces } = useWorkspaceStore();

    const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeSection, setActiveSection] = useState<BotSectionId>('general');
    const [drafts, setDrafts] = useState<Record<string, BotFormData>>({});
    const [snapshots, setSnapshots] = useState<Record<string, BotFormData>>({});
    const [tempBot, setTempBot] = useState<BotType | null>(null);
    const [previousBotId, setPreviousBotId] = useState<string | null>(null);
    const [pendingBotId, setPendingBotId] = useState<string | null>(null);
    const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
    const [pendingSwitchSource, setPendingSwitchSource] = useState<'manual' | 'filter' | null>(null);
    const [pageError, setPageError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isPersonaDirty, setIsPersonaDirty] = useState(false);
    const [isRolesDirty, setIsRolesDirty] = useState(false);
    const [pendingChannelActions, setPendingChannelActions] = useState<Record<'wecom' | 'feishu', 'connect' | 'disconnect' | null>>({
      wecom: null,
      feishu: null,
    });
    const personaEditorRef = useRef<BotPersonaEditorHandle>(null);
    const rolesEditorRef = useRef<BotRolePermissionsHandle>(null);

    const displayBots = useMemo(() => {
      return tempBot ? [...storeBots, tempBot] : storeBots;
    }, [storeBots, tempBot]);

    const trimmedQuery = searchQuery.trim();
    const filteredBots = useMemo(() => filterBotsByName(displayBots, trimmedQuery), [displayBots, trimmedQuery]);
    const matchCount = filteredBots.length;

    const selectedBot = useMemo(() => {
      return displayBots.find((b) => b.id === selectedBotId) || null;
    }, [displayBots, selectedBotId]);

    // Fetch data on mount.
    useEffect(() => {
      void fetchBots();
      void fetchWorkspaces();
    }, [fetchBots, fetchWorkspaces]);

    // Initialize selected bot once bots are available.
    useEffect(() => {
      if (selectedBotId) return;
      if (storeBots.length > 0) {
        setSelectedBotId(storeBots[0].id);
      }
    }, [storeBots, selectedBotId]);

    // Keep drafts/snapshots in sync with store bots.
    useEffect(() => {
      setDrafts((prev) => {
        const next = { ...prev };
        storeBots.forEach((bot) => {
          // Do not overwrite the draft of the currently selected bot.
          if (bot.id === selectedBotId && next[bot.id]) return;
          next[bot.id] = botToForm(bot);
        });
        return next;
      });
      setSnapshots((prev) => {
        const next: Record<string, BotFormData> = {};
        storeBots.forEach((bot) => {
          next[bot.id] = botToForm(bot);
        });
        // Preserve snapshots for temp bots so dirty detection still works.
        if (tempBot && prev[tempBot.id]) {
          next[tempBot.id] = prev[tempBot.id];
        }
        return next;
      });
    }, [storeBots, selectedBotId, tempBot]);

    // Handle deletion of the currently selected bot.
    useEffect(() => {
      if (!selectedBotId) return;
      if (!displayBots.some((b) => b.id === selectedBotId)) {
        const fallback = displayBots[0]?.id ?? null;
        setSelectedBotId(fallback);
        setActiveSection('general');
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[selectedBotId];
          return next;
        });
        setSnapshots((prev) => {
          const next = { ...prev };
          delete next[selectedBotId];
          return next;
        });
      }
    }, [displayBots, selectedBotId]);

    // Reset to General when switching bots.
    useEffect(() => {
      setActiveSection('general');
      setPageError(null);
      setIsPersonaDirty(false);
      setIsRolesDirty(false);
    }, [selectedBotId]);

    // Fetch members/status when the selected bot changes.
    useEffect(() => {
      if (selectedBotId && !tempBot?.id.startsWith('temp-')) {
        void fetchMembers(selectedBotId);
        void fetchStatus(selectedBotId);
      }
    }, [selectedBotId, tempBot, fetchMembers, fetchStatus]);

    // Poll channel status while the Channels section is active.
    useEffect(() => {
      if (!selectedBotId || tempBot?.id.startsWith('temp-') || activeSection !== 'channels') {
        return;
      }
      void fetchStatus(selectedBotId);
      const interval = setInterval(() => void fetchStatus(selectedBotId), 5000);
      return () => clearInterval(interval);
    }, [selectedBotId, tempBot, activeSection, fetchStatus]);

    // Clear optimistic channel hints once polling reports a terminal status.
    useEffect(() => {
      if (!selectedBotId) return;
      const status = channelStatusByBotId[selectedBotId];
      if (!status) return;
      setPendingChannelActions((prev) => {
        const next = { ...prev };
        for (const key of ['wecom', 'feishu'] as const) {
          const terminal = status[key] === 'connected' || status[key] === 'error' || status[key] === 'disconnected';
          if (terminal) {
            next[key] = null;
          }
        }
        return next;
      });
    }, [channelStatusByBotId, selectedBotId]);

    const isBasicDirty = useCallback(() => {
      if (!selectedBotId) return false;
      if (tempBot?.id === selectedBotId) return true;
      const draft = drafts[selectedBotId];
      const snapshot = snapshots[selectedBotId];
      if (!draft || !snapshot) return false;
      return JSON.stringify(draft) !== JSON.stringify(snapshot);
    }, [drafts, snapshots, selectedBotId, tempBot]);

    const isDirty = useCallback(() => {
      return isBasicDirty() || isRolesDirty || isPersonaDirty;
    }, [isBasicDirty, isRolesDirty, isPersonaDirty]);

    // When the active filter hides the selected bot, fall back to the first visible match.
    useEffect(() => {
      if (!selectedBotId) return;
      if (filteredBots.some((b) => b.id === selectedBotId)) return;
      const fallback = filteredBots[0];
      if (!fallback) return;

      if (isDirty()) {
        setPendingBotId(fallback.id);
        setPendingSwitchSource('filter');
        setShowUnsavedDialog(true);
      } else {
        setSelectedBotId(fallback.id);
        setActiveSection('general');
      }
    }, [filteredBots, selectedBotId, isDirty]);

    const handleUpdate = useCallback((patch: Partial<BotFormData>) => {
      if (!selectedBotId) return;
      setDrafts((prev) => ({
        ...prev,
        [selectedBotId]: { ...prev[selectedBotId]!, ...patch },
      }));
      setPageError(null);
    }, [selectedBotId]);

    const handleSaveBasic = useCallback(async () => {
      if (!selectedBotId || !selectedBot) return;
      const draft = drafts[selectedBotId];
      if (!draft) return;

      setPageError(null);
      const validationError = validateBotForm(draft, !tempBot, t);
      if (validationError) {
        setPageError(validationError);
        throw new Error(validationError);
      }

      if (tempBot) {
        const input = buildCreateBotInput(draft);
        const bot = await createBot(input);
        if (bot) {
          const ownerAdds: Promise<unknown>[] = [];
          if (draft.wecomEnabled && draft.wecomOwnerUserId.trim()) {
            ownerAdds.push(
              addMember(bot.id, {
                channel: 'wecom',
                channelUserId: draft.wecomOwnerUserId.trim(),
                role: 'owner',
              }),
            );
          }
          if (draft.feishuEnabled && draft.feishuOwnerUserId.trim()) {
            ownerAdds.push(
              addMember(bot.id, {
                channel: 'feishu',
                channelUserId: draft.feishuOwnerUserId.trim(),
                role: 'owner',
              }),
            );
          }
          await Promise.all(ownerAdds);

          setTempBot(null);
          setSelectedBotId(bot.id);
          setSnapshots((prev) => ({
            ...prev,
            [bot.id]: botToForm(bot),
          }));
          setDrafts((prev) => ({
            ...prev,
            [bot.id]: botToForm(bot),
          }));
          setPageError(null);
        } else {
          const err = storeError || t('common:unknownError');
          setPageError(err);
          throw new Error(err);
        }
      } else {
        const preSaveSnapshot = snapshots[selectedBotId];
        const input = buildUpdateBotInput(draft, selectedBot);
        const bot = await updateBot(selectedBotId, input);
        if (bot) {
          const postForm = botToForm(bot);
          setPendingChannelActions((prev) => ({
            wecom:
              deriveChannelPendingAction(preSaveSnapshot, postForm, 'wecom') ?? prev.wecom,
            feishu:
              deriveChannelPendingAction(preSaveSnapshot, postForm, 'feishu') ?? prev.feishu,
          }));
          setSnapshots((prev) => ({
            ...prev,
            [selectedBotId]: postForm,
          }));
          setDrafts((prev) => ({
            ...prev,
            [selectedBotId]: postForm,
          }));
          setPageError(null);
          void fetchStatus(selectedBotId);
        } else {
          const err = storeError || t('common:unknownError');
          setPageError(err);
          throw new Error(err);
        }
      }
    }, [selectedBotId, selectedBot, drafts, tempBot, createBot, updateBot, storeError, t, addMember, fetchStatus, snapshots]);

    const handleCancelBasic = useCallback(() => {
      if (!selectedBotId) return;
      if (tempBot && selectedBotId === tempBot.id) {
        setTempBot(null);
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[selectedBotId];
          return next;
        });
        setSnapshots((prev) => {
          const next = { ...prev };
          delete next[selectedBotId];
          return next;
        });
        setSelectedBotId(previousBotId);
        setPreviousBotId(null);
      } else {
        setDrafts((prev) => ({
          ...prev,
          [selectedBotId]: snapshots[selectedBotId] ? { ...snapshots[selectedBotId]! } : prev[selectedBotId]!,
        }));
      }
      setPageError(null);
    }, [selectedBotId, tempBot, previousBotId, snapshots]);

    const handleReconnectChannel = useCallback(
      async (channelKey: 'wecom' | 'feishu') => {
        if (!selectedBotId) return;
        setPendingChannelActions((prev) => ({ ...prev, [channelKey]: 'connect' }));
        const result = await reconnectChannel(selectedBotId, channelKey);
        if (result.ok) {
          setPageError(null);
          void fetchStatus(selectedBotId);
        } else {
          setPendingChannelActions((prev) => ({ ...prev, [channelKey]: null }));
          setPageError(result.error || t('common:unknownError'));
        }
      },
      [selectedBotId, reconnectChannel, fetchStatus, t],
    );

    const handleSaveAll = useCallback(async () => {
      setIsSaving(true);
      try {
        if (isBasicDirty()) {
          await handleSaveBasic();
        }
        if (rolesEditorRef.current?.isDirty()) {
          await rolesEditorRef.current.save();
        }
        if (personaEditorRef.current?.isDirty()) {
          await personaEditorRef.current.save();
        }
      } finally {
        setIsSaving(false);
      }
    }, [isBasicDirty, handleSaveBasic]);

    const handleDiscardAll = useCallback(() => {
      handleCancelBasic();
      rolesEditorRef.current?.discard();
      personaEditorRef.current?.discard();
    }, [handleCancelBasic]);

    const handleSelectBot = useCallback((id: string) => {
      if (id === selectedBotId) return;
      if (isDirty()) {
        setPendingBotId(id);
        setPendingSwitchSource('manual');
        setShowUnsavedDialog(true);
        return;
      }
      setSelectedBotId(id);
    }, [selectedBotId, isDirty]);

    const handleCreateBot = useCallback(() => {
      const tempId = `temp-${crypto.randomUUID()}`;
      const bot: BotType = {
        id: tempId,
        name: t('bots.newBotName'),
        activeWorkspaceId: null,
        channelSettings: {},
        rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setPreviousBotId(selectedBotId);
      setTempBot(bot);
      setDrafts((prev) => ({
        ...prev,
        [tempId]: emptyForm(),
      }));
      setSnapshots((prev) => ({
        ...prev,
        [tempId]: emptyForm(),
      }));
      setSelectedBotId(tempId);
      setActiveSection('general');
      setPageError(null);
    }, [selectedBotId, t]);

    const handleSaveRolePolicy = useCallback(
      async (rolePolicy: Parameters<typeof updateBot>[1]['rolePolicy']) => {
        if (!selectedBot || tempBot?.id === selectedBot.id) return;
        const bot = await updateBot(selectedBot.id, { rolePolicy });
        if (!bot) {
          throw new Error(storeError || t('common:unknownError'));
        }
      },
      [selectedBot, tempBot, updateBot, storeError, t],
    );

    const handleSavePersona = useCallback(
      async (payload: {
        persona: BotPersona | null;
        rolePersonas: Partial<Record<BotRole, BotPersona>>;
      }) => {
        if (!selectedBot || tempBot?.id === selectedBot.id) return;
        const bot = await updateBot(selectedBot.id, payload);
        if (!bot) {
          throw new Error(storeError || t('common:unknownError'));
        }
      },
      [selectedBot, tempBot, updateBot, storeError, t],
    );

    const handleDeleteBot = useCallback(async () => {
      if (!selectedBot || tempBot?.id === selectedBot.id) return;
      const ok = await deleteBot(selectedBot.id);
      if (!ok) {
        setPageError(storeError || t('common:unknownError'));
      }
    }, [selectedBot, tempBot, deleteBot, storeError, t]);

    const handleDialogSave = useCallback(async () => {
      await handleSaveAll();
      if (pendingBotId) {
        setSelectedBotId(pendingBotId);
        setActiveSection('general');
        setPendingBotId(null);
      }
      setPendingSwitchSource(null);
      setShowUnsavedDialog(false);
    }, [handleSaveAll, pendingBotId]);

    const handleDialogDiscard = useCallback(() => {
      handleDiscardAll();
      if (pendingBotId) {
        setSelectedBotId(pendingBotId);
        setActiveSection('general');
        setPendingBotId(null);
      }
      setPendingSwitchSource(null);
      setShowUnsavedDialog(false);
    }, [handleDiscardAll, pendingBotId]);

    const handleDialogKeepEditing = useCallback(() => {
      setPendingBotId(null);
      setPendingSwitchSource(null);
      setShowUnsavedDialog(false);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        isDirty,
        save: handleSaveAll,
        discard: handleDiscardAll,
      }),
      [isDirty, handleSaveAll, handleDiscardAll],
    );

    const sections = useMemo(
      () => [
        { id: 'general' as BotSectionId, label: t('bots.sections.general') },
        { id: 'channels' as BotSectionId, label: t('bots.sections.channels') },
        { id: 'members' as BotSectionId, label: t('bots.sections.members') },
        { id: 'roles' as BotSectionId, label: t('bots.sections.roles') },
        { id: 'persona' as BotSectionId, label: t('bots.sections.persona') },
        { id: 'danger' as BotSectionId, label: t('bots.sections.danger') },
      ],
      [t],
    );

    const draft = selectedBotId ? drafts[selectedBotId] : null;
    const isNew = !!tempBot && selectedBotId === tempBot.id;

    const footer = (
      <>
        <span className="text-[11px] text-text-tertiary">
          {pageError ? (
            <span className="text-destructive">{pageError}</span>
          ) : isDirty() ? (
            t('unsavedDialog.message')
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDiscardAll}
            disabled={isSaving || !isDirty()}
            className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active disabled:opacity-50 rounded-lg transition-colors"
          >
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSaveAll()}
            disabled={isSaving || !isDirty()}
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
                {t('actions.save')}
              </>
            )}
          </button>
        </div>
      </>
    );

    const renderContent = () => {
      if (!selectedBot || !draft) {
        return (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-text-tertiary" />
          </div>
        );
      }

      return (
        <>
          {(storeError || pageError) && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">{pageError || storeError}</p>
              <button
                onClick={clearError}
                className="text-[10px] text-destructive underline ml-auto"
              >
                {t('actions.dismiss')}
              </button>
            </div>
          )}

          {activeSection === 'general' && (
            <BotGeneralSection
              form={draft}
              onUpdate={handleUpdate}
              workspaces={workspaces}
            />
          )}

          {activeSection === 'channels' && (
            <BotChannelsSection
              form={draft}
              onUpdate={handleUpdate}
              originalBot={isNew ? null : selectedBot}
              channelStatus={channelStatusByBotId[selectedBot.id]}
              pendingActions={pendingChannelActions}
              onReconnect={handleReconnectChannel}
            />
          )}

          {activeSection === 'members' && !isNew && (
            <BotUserList
              botId={selectedBot.id}
              members={membersByBotId[selectedBot.id] || []}
              isLoading={isLoading}
              isSaving={isSaving}
              error={storeError}
              onSetRole={(channel, channelUserId, role) => setMemberRole(selectedBot.id, channel, channelUserId, role)}
              onRemoveMember={(channel, channelUserId) => removeMember(selectedBot.id, channel, channelUserId)}
              onRefreshMembers={() => refreshMembers(selectedBot.id)}
              onResolvePending={() => resolvePendingMembers(selectedBot.id)}
              onSetPlaintext={(channel, channelUserId, plaintextUserId) =>
                setMemberPlaintext(selectedBot.id, channel, channelUserId, plaintextUserId)
              }
            />
          )}

          {activeSection === 'roles' && !isNew && (
            <BotRolePermissions
              ref={rolesEditorRef}
              bot={selectedBot}
              error={storeError}
              onSave={handleSaveRolePolicy}
              onDirtyChange={setIsRolesDirty}
            />
          )}

          {activeSection === 'persona' && !isNew && (
            <BotPersonaEditor
              ref={personaEditorRef}
              bot={selectedBot}
              error={storeError}
              onSave={handleSavePersona}
              onDirtyChange={setIsPersonaDirty}
            />
          )}

          {activeSection === 'danger' && !isNew && (
            <BotDangerSection
              botName={selectedBot.name}
              onDelete={handleDeleteBot}
              isLoading={isSaving}
              error={storeError}
            />
          )}
        </>
      );
    };

    return (
      <>
        <BotTabShell
          bots={filteredBots}
          selectedBotId={selectedBotId}
          onSelectBot={handleSelectBot}
          onCreateBot={handleCreateBot}
          sections={sections}
          activeSection={activeSection}
          onSelectSection={(id) => setActiveSection(id as BotSectionId)}
          footer={footer}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          matchCount={matchCount}
          emptyState={
            <BotEmptyState
              onCreateBot={() => {
                setPreviousBotId(selectedBotId);
                handleCreateBot();
              }}
            />
          }
        >
          {renderContent()}
        </BotTabShell>

        {showUnsavedDialog && (
          <div className="fixed top-11 inset-x-0 bottom-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-overlay/60 backdrop-blur-sm" onClick={handleDialogKeepEditing} />
            <div className="relative bg-surface border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-medium text-text-primary">{t('unsavedDialog.title')}</h3>
                  <p className="text-xs text-text-secondary mt-1">{t('unsavedDialog.message')}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                {pendingSwitchSource !== 'filter' && (
                  <button
                    type="button"
                    onClick={handleDialogKeepEditing}
                    className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                  >
                    {t('unsavedDialog.keepEditing')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDialogDiscard}
                  className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
                >
                  {t('unsavedDialog.discard')}
                </button>
                <button
                  type="button"
                  onClick={handleDialogSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t('unsavedDialog.saving')}
                    </>
                  ) : (
                    t('unsavedDialog.saveChanges')
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  },
);

export default BotManagementPage;
