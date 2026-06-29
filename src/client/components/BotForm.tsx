import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Eye, EyeOff, Save, Bot as BotIcon, Loader2, AlertTriangle } from 'lucide-react';
import type { Bot, BotRolePolicy, CreateBotInput, UpdateBotInput } from '../stores/bot-store';
import type { Workspace } from '../stores/workspace-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { PermissionsSubTab } from './PermissionsSubTab';
import { SAFE_PRESET, type ToolPermissionPolicy } from '../types/wecom-permissions';

interface BotFormData {
  name: string;
  activeWorkspaceId: string;
  wecomEnabled: boolean;
  wecomBotId: string;
  wecomBotSecret: string;
  wecomBotName: string;
  wecomCorpId: string;
  wecomCorpSecret: string;
  feishuEnabled: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuEncryptKey: string;
  feishuVerificationToken: string;
  feishuBotName: string;
  normalToolPolicy: ToolPermissionPolicy;
  skillAllowlist: string;
  bashWhitelist: string;
}

function emptyForm(): BotFormData {
  return {
    name: '',
    activeWorkspaceId: '',
    wecomEnabled: false,
    wecomBotId: '',
    wecomBotSecret: '',
    wecomBotName: '',
    wecomCorpId: '',
    wecomCorpSecret: '',
    feishuEnabled: false,
    feishuAppId: '',
    feishuAppSecret: '',
    feishuEncryptKey: '',
    feishuVerificationToken: '',
    feishuBotName: '',
    normalToolPolicy: SAFE_PRESET,
    skillAllowlist: '',
    bashWhitelist: '',
  };
}

function botToForm(bot: Bot): BotFormData {
  const wecom = bot.providerSettings.wecom;
  const feishu = bot.providerSettings.feishu;
  const storedPolicy = bot.rolePolicy?.normalToolPolicy;
  const normalToolPolicy: ToolPermissionPolicy =
    storedPolicy &&
    typeof storedPolicy === 'object' &&
    'posture' in storedPolicy &&
    'categoryDefaults' in storedPolicy
      ? ((storedPolicy as unknown) as ToolPermissionPolicy)
      : SAFE_PRESET;
  return {
    name: bot.name,
    activeWorkspaceId: bot.activeWorkspaceId || '',
    wecomEnabled: !!wecom?.enabled,
    wecomBotId: typeof wecom?.botId === 'string' ? wecom.botId : '',
    wecomBotSecret: typeof wecom?.botSecret === 'string' ? wecom.botSecret : '',
    wecomBotName: typeof wecom?.botName === 'string' ? wecom.botName : '',
    wecomCorpId: typeof wecom?.corpId === 'string' ? wecom.corpId : '',
    wecomCorpSecret: typeof wecom?.corpSecret === 'string' ? wecom.corpSecret : '',
    feishuEnabled: !!feishu?.enabled,
    feishuAppId: typeof feishu?.appId === 'string' ? feishu.appId : '',
    feishuAppSecret: typeof feishu?.appSecret === 'string' ? feishu.appSecret : '',
    feishuEncryptKey: typeof feishu?.encryptKey === 'string' ? feishu.encryptKey : '',
    feishuVerificationToken: typeof feishu?.verificationToken === 'string' ? feishu.verificationToken : '',
    feishuBotName: typeof feishu?.botName === 'string' ? feishu.botName : '',
    normalToolPolicy,
    skillAllowlist: (bot.rolePolicy?.skillAllowlist ?? []).join('\n'),
    bashWhitelist: (bot.rolePolicy?.bashWhitelist ?? []).join('\n'),
  };
}

function isSecretSet(value: string | true | undefined): boolean {
  return value === true || (typeof value === 'string' && value.length > 0);
}

interface BotFormProps {
  bot?: Bot | null;
  workspaces: Workspace[];
  isSaving?: boolean;
  error?: string | null;
  onSubmit: (input: CreateBotInput | UpdateBotInput) => void | Promise<void>;
  onCancel: () => void;
}

export default function BotForm({ bot, workspaces, isSaving, error, onSubmit, onCancel }: BotFormProps) {
  const { t } = useTranslation('settings');
  const [form, setForm] = useState<BotFormData>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setForm(bot ? botToForm(bot) : emptyForm());
    setFormError(null);
  }, [bot]);

  const isEditing = !!bot;

  const updateForm = (patch: Partial<BotFormData>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const buildSecretValue = (
    current: string,
    original: string | true | undefined,
  ): string | true | undefined => {
    if (current.length > 0) return current;
    if (isSecretSet(original)) return true;
    return undefined;
  };

  const handleSubmit = () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError(t('bots.nameRequired'));
      return;
    }

    if (form.wecomEnabled && !form.wecomBotId.trim()) {
      setFormError(t('bots.wecomBotIdRequired'));
      return;
    }
    if (form.wecomEnabled && !isEditing && !form.wecomBotSecret.trim()) {
      setFormError(t('bots.wecomBotSecretRequired'));
      return;
    }
    if (form.feishuEnabled && !form.feishuAppId.trim()) {
      setFormError(t('bots.feishuAppIdRequired'));
      return;
    }
    if (form.feishuEnabled && !isEditing && !form.feishuAppSecret.trim()) {
      setFormError(t('bots.feishuAppSecretRequired'));
      return;
    }

    const providerSettings: CreateBotInput['providerSettings'] = {};
    if (form.wecomEnabled) {
      providerSettings.wecom = {
        enabled: true,
        botId: form.wecomBotId.trim(),
        botName: form.wecomBotName.trim() || undefined,
        corpId: form.wecomCorpId.trim() || undefined,
      };
      providerSettings.wecom.botSecret = buildSecretValue(
        form.wecomBotSecret,
        bot?.providerSettings.wecom?.botSecret,
      );
      providerSettings.wecom.corpSecret = buildSecretValue(
        form.wecomCorpSecret,
        bot?.providerSettings.wecom?.corpSecret,
      );
    }
    if (form.feishuEnabled) {
      providerSettings.feishu = {
        enabled: true,
        appId: form.feishuAppId.trim(),
        botName: form.feishuBotName.trim() || undefined,
      };
      providerSettings.feishu.appSecret = buildSecretValue(
        form.feishuAppSecret,
        bot?.providerSettings.feishu?.appSecret,
      );
      providerSettings.feishu.encryptKey = buildSecretValue(
        form.feishuEncryptKey,
        bot?.providerSettings.feishu?.encryptKey,
      );
      providerSettings.feishu.verificationToken = buildSecretValue(
        form.feishuVerificationToken,
        bot?.providerSettings.feishu?.verificationToken,
      );
    }

    const parseLines = (value: string) =>
      value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const rolePolicy: BotRolePolicy = {
      normalToolPolicy: (form.normalToolPolicy as unknown) as Record<string, unknown>,
      skillAllowlist: parseLines(form.skillAllowlist),
      bashWhitelist: parseLines(form.bashWhitelist),
    };

    const input: CreateBotInput | UpdateBotInput = {
      name: form.name.trim(),
      activeWorkspaceId: form.activeWorkspaceId || null,
      providerSettings,
      rolePolicy,
    };

    onSubmit(input);
  };

  const toggleSecret = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderSecretInput = (props: {
    id: string;
    label: string;
    value: string;
    placeholder: string;
    original: string | true | undefined;
    onChange: (value: string) => void;
  }) => {
    const show = showSecrets[props.id];
    const isSet = isSecretSet(props.original) && props.value === '';
    return (
      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">{props.label}</label>
        <div className="flex gap-2">
          <input
            type={show ? 'text' : 'password'}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder={isSet ? '••••••••' : props.placeholder}
            className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
          />
          <button
            type="button"
            onClick={() => toggleSecret(props.id)}
            className="p-2 rounded-lg border border-border hover:bg-surface-hover text-text-tertiary transition-colors"
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
          <BotIcon className="w-3.5 h-3.5" />
          {isEditing ? t('bots.editBot') : t('bots.createBot')}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {(error || formError) && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{formError || error}</p>
        </div>
      )}

      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">
          {t('bots.name')} *
        </label>
        <input
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder={t('bots.namePlaceholder')}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-text-tertiary mb-1">
          {t('bots.activeWorkspace')}
        </label>
        <Select
          value={form.activeWorkspaceId}
          onValueChange={(value) => updateForm({ activeWorkspaceId: value })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('bots.noActiveWorkspace')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('bots.noActiveWorkspace')}</SelectItem>
            {workspaces.map((ws) => (
              <SelectItem key={ws.id} value={ws.id}>
                {ws.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* WeCom */}
      <div className="pt-2 border-t border-border/50 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">{t('bots.wecomEnable')}</label>
          <button
            type="button"
            onClick={() => updateForm({ wecomEnabled: !form.wecomEnabled })}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              form.wecomEnabled ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                form.wecomEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {form.wecomEnabled && (
          <div className="space-y-3 pl-1 border-l-2 border-border/50">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomBotId')} *
                </label>
                <input
                  value={form.wecomBotId}
                  onChange={(e) => updateForm({ wecomBotId: e.target.value })}
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
                  onChange={(e) => updateForm({ wecomBotName: e.target.value })}
                  placeholder={t('bots.wecomBotNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
            </div>
            {renderSecretInput({
              id: 'wecomBotSecret',
              label: t('bots.wecomBotSecret') + (isEditing ? '' : ' *'),
              value: form.wecomBotSecret,
              placeholder: t('bots.wecomBotSecretPlaceholder'),
              original: bot?.providerSettings.wecom?.botSecret,
              onChange: (value) => updateForm({ wecomBotSecret: value }),
            })}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.wecomCorpId')}
                </label>
                <input
                  value={form.wecomCorpId}
                  onChange={(e) => updateForm({ wecomCorpId: e.target.value })}
                  placeholder={t('bots.wecomCorpIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
              {renderSecretInput({
                id: 'wecomCorpSecret',
                label: t('bots.wecomCorpSecret'),
                value: form.wecomCorpSecret,
                placeholder: t('bots.wecomCorpSecretPlaceholder'),
                original: bot?.providerSettings.wecom?.corpSecret,
                onChange: (value) => updateForm({ wecomCorpSecret: value }),
              })}
            </div>
          </div>
        )}
      </div>

      {/* Feishu */}
      <div className="pt-2 border-t border-border/50 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-text-secondary">{t('bots.feishuEnable')}</label>
          <button
            type="button"
            onClick={() => updateForm({ feishuEnabled: !form.feishuEnabled })}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              form.feishuEnabled ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                form.feishuEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {form.feishuEnabled && (
          <div className="space-y-3 pl-1 border-l-2 border-border/50">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-tertiary mb-1">
                  {t('bots.feishuAppId')} *
                </label>
                <input
                  value={form.feishuAppId}
                  onChange={(e) => updateForm({ feishuAppId: e.target.value })}
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
                  onChange={(e) => updateForm({ feishuBotName: e.target.value })}
                  placeholder={t('bots.feishuBotNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary"
                />
              </div>
            </div>
            {renderSecretInput({
              id: 'feishuAppSecret',
              label: t('bots.feishuAppSecret') + (isEditing ? '' : ' *'),
              value: form.feishuAppSecret,
              placeholder: t('bots.feishuAppSecretPlaceholder'),
              original: bot?.providerSettings.feishu?.appSecret,
              onChange: (value) => updateForm({ feishuAppSecret: value }),
            })}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {renderSecretInput({
                id: 'feishuEncryptKey',
                label: t('bots.feishuEncryptKey'),
                value: form.feishuEncryptKey,
                placeholder: t('bots.feishuEncryptKeyPlaceholder'),
                original: bot?.providerSettings.feishu?.encryptKey,
                onChange: (value) => updateForm({ feishuEncryptKey: value }),
              })}
              {renderSecretInput({
                id: 'feishuVerificationToken',
                label: t('bots.feishuVerificationToken'),
                value: form.feishuVerificationToken,
                placeholder: t('bots.feishuVerificationTokenPlaceholder'),
                original: bot?.providerSettings.feishu?.verificationToken,
                onChange: (value) => updateForm({ feishuVerificationToken: value }),
              })}
            </div>
          </div>
        )}
      </div>

      {/* Role permissions */}
      <div className="pt-2 border-t border-border/50 space-y-4">
        <div>
          <h4 className="text-xs font-medium text-text-secondary">{t('bots.rolePermissions.title')}</h4>
          <p className="text-[10px] text-text-tertiary mt-0.5">{t('bots.rolePermissions.description')}</p>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-text-tertiary mb-2">
            {t('bots.rolePermissions.toolPolicy')}
          </label>
          <PermissionsSubTab
            policy={form.normalToolPolicy}
            onUpdate={(next) => updateForm({ normalToolPolicy: next })}
            workspaceId={bot?.id || 'new-bot'}
            needsUpgradePrompt={false}
            onApplySafePreset={async () => updateForm({ normalToolPolicy: SAFE_PRESET })}
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium text-text-tertiary mb-1">
            {t('bots.rolePermissions.skillAllowlist')}
          </label>
          <textarea
            value={form.skillAllowlist}
            onChange={(e) => updateForm({ skillAllowlist: e.target.value })}
            placeholder={t('bots.rolePermissions.skillAllowlistPlaceholder')}
            rows={3}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
          />
          <p className="text-[10px] text-text-tertiary mt-1">{t('bots.rolePermissions.skillAllowlistHint')}</p>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-text-tertiary mb-1">
            {t('bots.rolePermissions.bashWhitelist')}
          </label>
          <textarea
            value={form.bashWhitelist}
            onChange={(e) => updateForm({ bashWhitelist: e.target.value })}
            placeholder={t('bots.rolePermissions.bashWhitelistPlaceholder')}
            rows={3}
            className="w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary placeholder:text-text-tertiary resize-y font-mono text-[12px]"
          />
          <p className="text-[10px] text-text-tertiary mt-1">{t('bots.rolePermissions.bashWhitelistHint')}</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-hover hover:bg-surface-active rounded-lg transition-colors"
        >
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-foreground rounded-lg transition-colors"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('actions.saving')}
            </>
          ) : (
            <>
              <Save className="w-3.5 h-3.5" />
              {t('actions.save')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
