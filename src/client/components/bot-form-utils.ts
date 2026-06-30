import type { Bot, CreateBotInput, UpdateBotInput } from '../stores/bot-store';
import type { TFunction } from 'i18next';

export interface BotFormData {
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
}

export function emptyForm(): BotFormData {
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
  };
}

export function botToForm(bot: Bot): BotFormData {
  const wecom = bot.providerSettings.wecom;
  const feishu = bot.providerSettings.feishu;
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
  };
}

export function isSecretSet(value: string | true | undefined): boolean {
  return value === true || (typeof value === 'string' && value.length > 0);
}

export function buildSecretValue(
  current: string,
  original: string | true | undefined,
): string | true | undefined {
  if (current.length > 0) return current;
  if (isSecretSet(original)) return true;
  return undefined;
}

export function buildBotInput(
  form: BotFormData,
  original: Bot | null | undefined,
): CreateBotInput | UpdateBotInput {
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
      original?.providerSettings.wecom?.botSecret,
    );
    providerSettings.wecom.corpSecret = buildSecretValue(
      form.wecomCorpSecret,
      original?.providerSettings.wecom?.corpSecret,
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
      original?.providerSettings.feishu?.appSecret,
    );
    providerSettings.feishu.encryptKey = buildSecretValue(
      form.feishuEncryptKey,
      original?.providerSettings.feishu?.encryptKey,
    );
    providerSettings.feishu.verificationToken = buildSecretValue(
      form.feishuVerificationToken,
      original?.providerSettings.feishu?.verificationToken,
    );
  }

  return {
    name: form.name.trim(),
    activeWorkspaceId: form.activeWorkspaceId || null,
    providerSettings,
  };
}

export function validateBotForm(
  form: BotFormData,
  isEditing: boolean,
  t: TFunction,
): string | null {
  if (!form.name.trim()) {
    return t('bots.nameRequired');
  }

  if (form.wecomEnabled && !form.wecomBotId.trim()) {
    return t('bots.wecomBotIdRequired');
  }
  if (form.wecomEnabled && !isEditing && !form.wecomBotSecret.trim()) {
    return t('bots.wecomBotSecretRequired');
  }
  if (form.feishuEnabled && !form.feishuAppId.trim()) {
    return t('bots.feishuAppIdRequired');
  }
  if (form.feishuEnabled && !isEditing && !form.feishuAppSecret.trim()) {
    return t('bots.feishuAppSecretRequired');
  }

  return null;
}
