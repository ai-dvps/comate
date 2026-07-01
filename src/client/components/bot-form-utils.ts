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
  wecomOwnerUserId: string;
  feishuEnabled: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuEncryptKey: string;
  feishuVerificationToken: string;
  feishuBotName: string;
  feishuOwnerUserId: string;
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
    wecomOwnerUserId: '',
    feishuEnabled: false,
    feishuAppId: '',
    feishuAppSecret: '',
    feishuEncryptKey: '',
    feishuVerificationToken: '',
    feishuBotName: '',
    feishuOwnerUserId: '',
  };
}

export function botToForm(bot: Bot): BotFormData {
  const wecom = bot.channelSettings.wecom;
  const feishu = bot.channelSettings.feishu;
  return {
    name: bot.name,
    activeWorkspaceId: bot.activeWorkspaceId || '',
    wecomEnabled: !!wecom?.enabled,
    wecomBotId: typeof wecom?.botId === 'string' ? wecom.botId : '',
    wecomBotSecret: typeof wecom?.botSecret === 'string' ? wecom.botSecret : '',
    wecomBotName: typeof wecom?.botName === 'string' ? wecom.botName : '',
    wecomCorpId: typeof wecom?.corpId === 'string' ? wecom.corpId : '',
    wecomCorpSecret: typeof wecom?.corpSecret === 'string' ? wecom.corpSecret : '',
    wecomOwnerUserId: '',
    feishuEnabled: !!feishu?.enabled,
    feishuAppId: typeof feishu?.appId === 'string' ? feishu.appId : '',
    feishuAppSecret: typeof feishu?.appSecret === 'string' ? feishu.appSecret : '',
    feishuEncryptKey: typeof feishu?.encryptKey === 'string' ? feishu.encryptKey : '',
    feishuVerificationToken: typeof feishu?.verificationToken === 'string' ? feishu.verificationToken : '',
    feishuBotName: typeof feishu?.botName === 'string' ? feishu.botName : '',
    feishuOwnerUserId: '',
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

export function buildCreateBotInput(form: BotFormData): CreateBotInput {
  const channelSettings: CreateBotInput['channelSettings'] = {};

  if (form.wecomEnabled) {
    channelSettings.wecom = {
      enabled: true,
      botId: form.wecomBotId.trim(),
      botName: form.wecomBotName.trim() || undefined,
      corpId: form.wecomCorpId.trim() || undefined,
    };
    channelSettings.wecom.botSecret = buildSecretValue(
      form.wecomBotSecret,
      undefined,
    );
    channelSettings.wecom.corpSecret = buildSecretValue(
      form.wecomCorpSecret,
      undefined,
    );
  }

  if (form.feishuEnabled) {
    channelSettings.feishu = {
      enabled: true,
      appId: form.feishuAppId.trim(),
      botName: form.feishuBotName.trim() || undefined,
    };
    channelSettings.feishu.appSecret = buildSecretValue(
      form.feishuAppSecret,
      undefined,
    );
    channelSettings.feishu.encryptKey = buildSecretValue(
      form.feishuEncryptKey,
      undefined,
    );
    channelSettings.feishu.verificationToken = buildSecretValue(
      form.feishuVerificationToken,
      undefined,
    );
  }

  return {
    name: form.name.trim(),
    activeWorkspaceId: form.activeWorkspaceId || undefined,
    channelSettings,
  };
}

export function buildUpdateBotInput(
  form: BotFormData,
  original: Bot | null | undefined,
): UpdateBotInput {
  const channelSettings: UpdateBotInput['channelSettings'] = {};

  if (form.wecomEnabled) {
    channelSettings.wecom = {
      enabled: true,
      botId: form.wecomBotId.trim(),
      botName: form.wecomBotName.trim() || undefined,
      corpId: form.wecomCorpId.trim() || undefined,
    };
    channelSettings.wecom.botSecret = buildSecretValue(
      form.wecomBotSecret,
      original?.channelSettings.wecom?.botSecret,
    );
    channelSettings.wecom.corpSecret = buildSecretValue(
      form.wecomCorpSecret,
      original?.channelSettings.wecom?.corpSecret,
    );
  }

  if (form.feishuEnabled) {
    channelSettings.feishu = {
      enabled: true,
      appId: form.feishuAppId.trim(),
      botName: form.feishuBotName.trim() || undefined,
    };
    channelSettings.feishu.appSecret = buildSecretValue(
      form.feishuAppSecret,
      original?.channelSettings.feishu?.appSecret,
    );
    channelSettings.feishu.encryptKey = buildSecretValue(
      form.feishuEncryptKey,
      original?.channelSettings.feishu?.encryptKey,
    );
    channelSettings.feishu.verificationToken = buildSecretValue(
      form.feishuVerificationToken,
      original?.channelSettings.feishu?.verificationToken,
    );
  }

  return {
    name: form.name.trim(),
    activeWorkspaceId: form.activeWorkspaceId || null,
    channelSettings,
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
  if (form.wecomEnabled && !isEditing && !form.wecomOwnerUserId.trim()) {
    return t('bots.wecomOwnerUserIdRequired');
  }
  if (form.feishuEnabled && !form.feishuAppId.trim()) {
    return t('bots.feishuAppIdRequired');
  }
  if (form.feishuEnabled && !isEditing && !form.feishuAppSecret.trim()) {
    return t('bots.feishuAppSecretRequired');
  }
  if (form.feishuEnabled && !isEditing && !form.feishuOwnerUserId.trim()) {
    return t('bots.feishuOwnerUserIdRequired');
  }

  return null;
}
