import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Bot } from '../stores/bot-store';
import { type BotFormData, botToForm } from './bot-form-utils';
import SecretInput from './SecretInput';
import {
  CHANNEL_STATUS_DOT,
  type ChannelStatus,
} from '../hooks/use-channel-statuses';

interface BotChannelsSectionProps {
  form: BotFormData;
  onUpdate: (patch: Partial<BotFormData>) => void;
  originalBot?: Bot | null;
  channelStatus?: { wecom: ChannelStatus; feishu: ChannelStatus; errors?: { wecom?: string; feishu?: string } };
  pendingActions?: Record<'wecom' | 'feishu', 'connect' | 'disconnect' | null>;
  onReconnect?: (channelKey: 'wecom' | 'feishu') => void;
}

function getChannelLabel(
  channel: 'wecom' | 'feishu',
  status: ChannelStatus,
  t: (key: string) => string,
): string {
  const suffix: Record<ChannelStatus, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
    not_configured: 'NotConfigured',
    connecting: 'Connecting',
  };
  const key = channel === 'wecom' ? `wecomStatus${suffix[status]}` : `feishuStatus${suffix[status]}`;
  return t(`bots.${key}`);
}

function isChannelDirty(
  form: BotFormData,
  originalBot: Bot | null | undefined,
  channel: 'wecom' | 'feishu',
): boolean {
  if (!originalBot) return false;
  const snapshot = botToForm(originalBot);
  if (channel === 'wecom') {
    return (
      form.wecomEnabled !== snapshot.wecomEnabled ||
      form.wecomBotId !== snapshot.wecomBotId ||
      form.wecomBotSecret !== snapshot.wecomBotSecret ||
      form.wecomBotName !== snapshot.wecomBotName ||
      form.wecomCorpId !== snapshot.wecomCorpId ||
      form.wecomCorpSecret !== snapshot.wecomCorpSecret
    );
  }
  return (
    form.feishuEnabled !== snapshot.feishuEnabled ||
    form.feishuAppId !== snapshot.feishuAppId ||
    form.feishuAppSecret !== snapshot.feishuAppSecret ||
    form.feishuBotName !== snapshot.feishuBotName ||
    form.feishuEncryptKey !== snapshot.feishuEncryptKey ||
    form.feishuVerificationToken !== snapshot.feishuVerificationToken
  );
}

export default function BotChannelsSection({
  form,
  onUpdate,
  originalBot,
  channelStatus,
  pendingActions,
  onReconnect,
}: BotChannelsSectionProps) {
  const { t } = useTranslation('settings');

  const Toggle = ({
    checked,
    onChange,
    label,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: string;
  }) => (
    <div className="flex items-center justify-between">
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        aria-label={label}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );

  const ChannelCard = ({
    channel,
    title,
    children,
  }: {
    channel: 'wecom' | 'feishu';
    title: string;
    children: React.ReactNode;
  }) => {
    const enabled = channel === 'wecom' ? form.wecomEnabled : form.feishuEnabled;
    const status: ChannelStatus = channelStatus?.[channel] ?? 'not_configured';
    const pending = pendingActions?.[channel];
    const errorMessage = channelStatus?.errors?.[channel];
    const dirty = isChannelDirty(form, originalBot, channel);
    const canReconnect =
      enabled &&
      !dirty &&
      status === 'disconnected' &&
      !pending &&
      !!onReconnect;

    const statusLabel = pending
      ? t(`bots.${pending === 'connect' ? 'channelReconnecting' : 'channelDisconnecting'}`)
      : getChannelLabel(channel, status, t);

    return (
      <div className="border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-xs font-medium text-text-secondary">{title}</h4>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className={`flex items-center gap-1.5 text-xs ${enabled ? 'text-text-secondary' : 'text-text-tertiary opacity-60'}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-describedby={errorMessage ? `${channel}-error` : undefined}
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  pending ? 'bg-blue-500 animate-pulse' : CHANNEL_STATUS_DOT[status]
                }`}
                aria-hidden="true"
              />
              {pending && (
                <Loader2 className="w-3 h-3 animate-spin text-text-tertiary" aria-hidden="true" />
              )}
              <span>
                {statusLabel}
                {!enabled && !pending && ` ${t('bots.channelStatusDisabled')}`}
              </span>
            </span>
            {canReconnect && (
              <button
                type="button"
                onClick={() => onReconnect?.(channel)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-md transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                {t('bots.reconnectButton')}
              </button>
            )}
          </div>
        </div>

        {errorMessage && (
          <p
            id={`${channel}-error`}
            className="text-[11px] text-warning"
          >
            {errorMessage}
          </p>
        )}

        <Toggle
          label={t(channel === 'wecom' ? 'bots.wecomEnable' : 'bots.feishuEnable')}
          checked={enabled}
          onChange={(value) =>
            onUpdate(channel === 'wecom' ? { wecomEnabled: value } : { feishuEnabled: value })
          }
        />

        {children}
      </div>
    );
  };

  return (
    <div className="max-w-xl space-y-6">
      <ChannelCard channel="wecom" title={t('bots.channelWecom')}>
        {form.wecomEnabled && (
          <div className="space-y-3 pl-1 border-l-2 border-border/50">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomBotId')} *
                </label>
                <input
                  value={form.wecomBotId}
                  onChange={(e) => onUpdate({ wecomBotId: e.target.value })}
                  placeholder={t('bots.wecomBotIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomBotName')}
                </label>
                <input
                  value={form.wecomBotName}
                  onChange={(e) => onUpdate({ wecomBotName: e.target.value })}
                  placeholder={t('bots.wecomBotNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
            </div>
            <SecretInput
              id="wecomBotSecret"
              label={`${t('bots.wecomBotSecret')}${originalBot ? '' : ' *'}`}
              value={form.wecomBotSecret}
              placeholder={t('bots.wecomBotSecretPlaceholder')}
              original={originalBot?.channelSettings.wecom?.botSecret}
              onChange={(value) => onUpdate({ wecomBotSecret: value })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomCorpId')}
                </label>
                <input
                  value={form.wecomCorpId}
                  onChange={(e) => onUpdate({ wecomCorpId: e.target.value })}
                  placeholder={t('bots.wecomCorpIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
              <SecretInput
                id="wecomCorpSecret"
                label={t('bots.wecomCorpSecret')}
                value={form.wecomCorpSecret}
                placeholder={t('bots.wecomCorpSecretPlaceholder')}
                original={originalBot?.channelSettings.wecom?.corpSecret}
                onChange={(value) => onUpdate({ wecomCorpSecret: value })}
              />
            </div>
            {!originalBot && (
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomOwnerUserId')} *
                </label>
                <input
                  value={form.wecomOwnerUserId}
                  onChange={(e) => onUpdate({ wecomOwnerUserId: e.target.value })}
                  placeholder={t('bots.wecomOwnerUserIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <p className="mt-1 text-[10px] text-text-tertiary">{t('bots.ownerUserIdHint')}</p>
              </div>
            )}
          </div>
        )}
      </ChannelCard>

      <ChannelCard channel="feishu" title={t('bots.channelFeishu')}>
        {form.feishuEnabled && (
          <div className="space-y-3 pl-1 border-l-2 border-border/50">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.feishuAppId')} *
                </label>
                <input
                  value={form.feishuAppId}
                  onChange={(e) => onUpdate({ feishuAppId: e.target.value })}
                  placeholder={t('bots.feishuAppIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.feishuBotName')}
                </label>
                <input
                  value={form.feishuBotName}
                  onChange={(e) => onUpdate({ feishuBotName: e.target.value })}
                  placeholder={t('bots.feishuBotNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
            </div>
            <SecretInput
              id="feishuAppSecret"
              label={`${t('bots.feishuAppSecret')}${originalBot ? '' : ' *'}`}
              value={form.feishuAppSecret}
              placeholder={t('bots.feishuAppSecretPlaceholder')}
              original={originalBot?.channelSettings.feishu?.appSecret}
              onChange={(value) => onUpdate({ feishuAppSecret: value })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SecretInput
                id="feishuEncryptKey"
                label={t('bots.feishuEncryptKey')}
                value={form.feishuEncryptKey}
                placeholder={t('bots.feishuEncryptKeyPlaceholder')}
                original={originalBot?.channelSettings.feishu?.encryptKey}
                onChange={(value) => onUpdate({ feishuEncryptKey: value })}
              />
              <SecretInput
                id="feishuVerificationToken"
                label={t('bots.feishuVerificationToken')}
                value={form.feishuVerificationToken}
                placeholder={t('bots.feishuVerificationTokenPlaceholder')}
                original={originalBot?.channelSettings.feishu?.verificationToken}
                onChange={(value) => onUpdate({ feishuVerificationToken: value })}
              />
            </div>
            {!originalBot && (
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.feishuOwnerUserId')} *
                </label>
                <input
                  value={form.feishuOwnerUserId}
                  onChange={(e) => onUpdate({ feishuOwnerUserId: e.target.value })}
                  placeholder={t('bots.feishuOwnerUserIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
                <p className="mt-1 text-[10px] text-text-tertiary">{t('bots.ownerUserIdHint')}</p>
              </div>
            )}
          </div>
        )}
      </ChannelCard>
    </div>
  );
}
