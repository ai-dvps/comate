import { describe, it, expect } from 'vitest';
import { buildUpdateBotInput, emptyForm } from './bot-form-utils';
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
});
