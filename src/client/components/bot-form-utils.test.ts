import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  botToForm,
  buildCreateBotInput,
  buildUpdateBotInput,
  emptyForm,
  validateBotForm,
} from './bot-form-utils';
import type { Bot } from '../stores/bot-store';

describe('buildUpdateBotInput', () => {
  const baseBot: Bot = {
    id: 'bot-1',
    name: 'Bot',
    activeWorkspaceId: null,
    channelSettings: {
      wecom: {
        enabled: true,
        botId: 'wecom-bot-id',
        botSecret: 'wecom-bot-secret',
      },
    },
    rolePolicy: { normalToolPolicy: {}, skillAllowlist: [], bashWhitelist: [] },
    createdAt: '',
    updatedAt: '',
  };

  it('emits enabled: false when a channel is disabled', () => {
    const form = emptyForm();
    form.wecomEnabled = false;

    const input = buildUpdateBotInput(form, baseBot);

    expect(input.channelSettings?.wecom).toEqual({
      enabled: false,
      botId: 'wecom-bot-id',
      botSecret: true,
    });
  });

  it('preserves an enabled channel with unchanged secrets as sentinels', () => {
    const form = emptyForm();
    form.wecomEnabled = true;
    form.wecomBotId = 'wecom-bot-id';

    const input = buildUpdateBotInput(form, baseBot);

    expect(input.channelSettings?.wecom).toEqual({
      enabled: true,
      botId: 'wecom-bot-id',
      botSecret: true,
    });
  });

  it('round-trips and trims the Feishu server URL', () => {
    const bot = {
      ...baseBot,
      channelSettings: {
        feishu: {
          enabled: true,
          appId: 'feishu-app',
          appSecret: true,
          serverUrl: 'https://feishu.internal.example:8443',
        },
      },
    } satisfies Bot;
    const form = botToForm(bot);
    expect(form.feishuServerUrl).toBe('https://feishu.internal.example:8443');

    form.feishuServerUrl = '  https://new.feishu.internal:8443/  ';
    expect(buildUpdateBotInput(form, bot).channelSettings?.feishu?.serverUrl)
      .toBe('https://new.feishu.internal:8443/');
  });

  it('omits a blank server URL on create and preserves it while disabling Feishu', () => {
    const createForm = emptyForm();
    createForm.name = 'Bot';
    createForm.feishuEnabled = true;
    createForm.feishuAppId = 'feishu-app';
    createForm.feishuAppSecret = 'feishu-secret';
    createForm.feishuServerUrl = '   ';
    expect(buildCreateBotInput(createForm).channelSettings?.feishu?.serverUrl).toBeUndefined();

    const bot = {
      ...baseBot,
      channelSettings: {
        feishu: {
          enabled: true,
          appId: 'feishu-app',
          appSecret: true,
          serverUrl: 'https://feishu.internal',
        },
      },
    } satisfies Bot;
    const disabledForm = botToForm(bot);
    disabledForm.feishuEnabled = false;
    expect(buildUpdateBotInput(disabledForm, bot).channelSettings?.feishu?.serverUrl)
      .toBe('https://feishu.internal');
  });

  it('rejects unsafe Feishu server URLs in client validation', () => {
    const t = ((key: string) => key) as TFunction;
    const invalidUrls = [
      'http://feishu.internal',
      'not-a-url',
      'https://user:password@feishu.internal',
      'https://feishu.internal?tenant=1',
      'https://feishu.internal#fragment',
      'https://feishu.internal/open-apis',
    ];

    for (const feishuServerUrl of invalidUrls) {
      const form = emptyForm();
      form.name = 'Bot';
      form.feishuEnabled = true;
      form.feishuAppId = 'feishu-app';
      form.feishuAppSecret = 'feishu-secret';
      form.feishuServerUrl = feishuServerUrl;
      expect(validateBotForm(form, false, t)).toBe('bots.feishuServerUrlInvalid');
    }
  });
});
