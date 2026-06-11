import { Flags } from '@oclif/core';
import { BaseCommand } from '../base.js';
import { postJson } from '../../lib/http.js';

export default class QueueEnqueue extends BaseCommand {
  static override description = 'Enqueue a proactive WeCom message';

  static override flags = {
    'to-user': Flags.string({
      description: 'Target user ID',
      required: true,
    }),
    message: Flags.string({
      description: 'Message content',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(QueueEnqueue);
    const context = this.loadContext();

    if (!context.workspaceId) {
      this.error(
        "This workspace's WeCom context file is missing workspaceId.\n" +
          'Please reconnect the WeCom bot for this workspace to update the context file.',
        { exit: 1 }
      );
    }

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom-queue`;

    const response = await postJson(endpointUrl, { toUser: flags['to-user'], message: flags.message });

    if (response.status === 202) {
      try {
        const parsed = JSON.parse(response.body) as { id?: string; status?: string };
        if (parsed.id) {
          this.log(`Queued proactive message (id=${parsed.id}, status=${parsed.status || 'pending'})`);
        }
      } catch {
        // Ignore parse error; success is already confirmed by status code
      }
      return;
    }

    if (response.status === 400) {
      try {
        const parsed = JSON.parse(response.body) as { error?: string; message?: string };
        const code = parsed.error;
        if (code === 'recipient_not_resolved') {
          this.error(
            'Failed to enqueue: recipient user ID has not been decrypted yet. The recipient must send at least one message to the bot first.',
            { exit: 3 }
          );
        }
        if (code === 'recipient_no_session') {
          this.error('Failed to enqueue: recipient has no active session in this workspace.', { exit: 3 });
        }
        this.error(`Failed to enqueue: ${parsed.message || code || 'Bad request'}`, { exit: 3 });
      } catch {
        this.error(`Failed to enqueue: HTTP 400: ${response.body}`, { exit: 3 });
      }
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string; message?: string };
      errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    this.error(`Failed to enqueue: ${errorMessage}`, { exit: 3 });
  }
}
