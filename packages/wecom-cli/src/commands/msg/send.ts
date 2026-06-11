import { Flags } from '@oclif/core';
import { BaseCommand } from '../base.js';
import { postJson } from '../../lib/http.js';

export default class MsgSend extends BaseCommand {
  static override description = 'Send a WeCom message immediately';

  static override flags = {
    'to-user': Flags.string({
      description: 'Target user ID',
      required: true,
    }),
    message: Flags.string({
      description: 'Message content',
      required: true,
    }),
    'msg-type': Flags.string({
      description: 'Message type',
      options: ['text', 'markdown'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MsgSend);
    const context = this.loadContext();

    const endpointUrl = `${context.serverUrl}/api/wecom/send`;

    const response = await postJson(endpointUrl, {
      botId: context.botId,
      toUser: flags['to-user'],
      message: flags.message,
      msgType: flags['msg-type'],
    });

    if (response.status === 200) {
      return;
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string };
      errorMessage = parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    this.error(`Failed to send message: ${errorMessage}`, { exit: 3 });
  }
}
