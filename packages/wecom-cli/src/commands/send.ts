import { Flags } from '@oclif/core';
import { BaseCommand } from './base.js';
import { postJson } from '../lib/http.js';

export default class Send extends BaseCommand {
  static override description = 'Send a WeCom message to a user';

  static override flags = {
    'to-user': Flags.string({
      description: 'Target user ID',
      required: true,
    }),
    message: Flags.string({
      description: 'Message content',
      required: true,
    }),
    'session-id': Flags.string({
      description: 'Claude session ID (defaults to CLAUDE_SESSION_ID env var)',
      required: false,
    }),
    'msg-type': Flags.string({
      description: 'Message type',
      options: ['text', 'markdown'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Send);
    const context = this.loadContext();

    if (!context.workspaceId) {
      this.error(
        "This workspace's WeCom context file is missing workspaceId.\n" +
          'Please reconnect the WeCom bot for this workspace to update the context file.',
        { exit: 1 }
      );
    }

    const sessionId = flags['session-id'] || process.env.CLAUDE_SESSION_ID;
    if (!sessionId) {
      this.error(
        'Missing session ID. Provide --session-id or set the CLAUDE_SESSION_ID environment variable.',
        { exit: 1 }
      );
    }

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom/send`;

    const response = await postJson(endpointUrl, {
      sessionId,
      toUser: flags['to-user'],
      message: flags.message,
      msgType: flags['msg-type'],
    });

    if (response.status === 200) {
      try {
        const parsed = JSON.parse(response.body) as { method?: string };
        if (parsed.method === 'direct') {
          this.log('Message sent directly');
        } else {
          this.log('Message sent');
        }
      } catch {
        this.log('Message sent');
      }
      return;
    }

    if (response.status === 202) {
      try {
        const parsed = JSON.parse(response.body) as { method?: string; entryId?: string };
        if (parsed.method === 'queued' && parsed.entryId) {
          this.log(`Message queued for delivery (entryId=${parsed.entryId})`);
        } else {
          this.log('Message queued for delivery');
        }
      } catch {
        this.log('Message queued for delivery');
      }
      return;
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string; message?: string };
      errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    this.error(`Failed to send message: ${errorMessage}`, { exit: 3 });
  }
}
