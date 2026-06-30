import { useTranslation } from 'react-i18next';
import type { Bot } from '../stores/bot-store';
import { type BotFormData } from './bot-form-utils';
import SecretInput from './SecretInput';

interface BotProvidersSectionProps {
  form: BotFormData;
  onUpdate: (patch: Partial<BotFormData>) => void;
  originalBot?: Bot | null;
}

export default function BotProvidersSection({ form, onUpdate, originalBot }: BotProvidersSectionProps) {
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

  return (
    <div className="max-w-xl space-y-6">
      {/* WeCom */}
      <div className="border border-border rounded-lg p-4 space-y-4">
        <h4 className="text-xs font-medium text-text-secondary">{t('bots.providerWecom')}</h4>
        <Toggle
          label={t('bots.wecomEnable')}
          checked={form.wecomEnabled}
          onChange={(value) => onUpdate({ wecomEnabled: value })}
        />

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
              original={originalBot?.providerSettings.wecom?.botSecret}
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
                original={originalBot?.providerSettings.wecom?.corpSecret}
                onChange={(value) => onUpdate({ wecomCorpSecret: value })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Feishu */}
      <div className="border border-border rounded-lg p-4 space-y-4">
        <h4 className="text-xs font-medium text-text-secondary">{t('bots.providerFeishu')}</h4>
        <Toggle
          label={t('bots.feishuEnable')}
          checked={form.feishuEnabled}
          onChange={(value) => onUpdate({ feishuEnabled: value })}
        />

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
              original={originalBot?.providerSettings.feishu?.appSecret}
              onChange={(value) => onUpdate({ feishuAppSecret: value })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SecretInput
                id="feishuEncryptKey"
                label={t('bots.feishuEncryptKey')}
                value={form.feishuEncryptKey}
                placeholder={t('bots.feishuEncryptKeyPlaceholder')}
                original={originalBot?.providerSettings.feishu?.encryptKey}
                onChange={(value) => onUpdate({ feishuEncryptKey: value })}
              />
              <SecretInput
                id="feishuVerificationToken"
                label={t('bots.feishuVerificationToken')}
                value={form.feishuVerificationToken}
                placeholder={t('bots.feishuVerificationTokenPlaceholder')}
                original={originalBot?.providerSettings.feishu?.verificationToken}
                onChange={(value) => onUpdate({ feishuVerificationToken: value })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
