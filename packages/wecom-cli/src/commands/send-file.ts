import { Flags } from '@oclif/core';
import { BaseCommand } from './base.js';
import { postJson } from '../lib/http.js';

export default class SendFile extends BaseCommand {
  static override description = 'Send a workspace file to a WeCom user';

  static override flags = {
    'to-user': Flags.string({
      description: 'Target user ID',
      required: true,
    }),
    'file-path': Flags.string({
      description: 'Workspace-relative path to the file to send',
      required: true,
    }),
    'session-id': Flags.string({
      description: 'Claude session ID (defaults to CLAUDE_SESSION_ID env var)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SendFile);
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

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom/send-file`;

    const response = await postJson(endpointUrl, {
      sessionId,
      toUser: flags['to-user'],
      filePath: flags['file-path'],
    });

    if (response.status === 200) {
      this.log('File sent');
      return;
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string; message?: string };
      errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    this.error(`Failed to send file: ${errorMessage}`, { exit: 3 });
  }
}
