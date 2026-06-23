import { Flags } from '@oclif/core';
import { BaseCommand } from './base.js';
import { getJson } from '../lib/http.js';

export default class CurrentUser extends BaseCommand {
  static override description = 'Get the WeCom user ID for the current session';

  static override flags = {
    'session-id': Flags.string({
      description: 'Claude session ID (defaults to CLAUDE_SESSION_ID env var)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(CurrentUser);
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

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/sessions/${sessionId}/wecom-user`;

    const response = await getJson(endpointUrl);

    if (response.status === 200) {
      let parsed: { userId?: string };
      try {
        parsed = JSON.parse(response.body) as { userId?: string };
      } catch {
        this.error(`Failed to parse server response: ${response.body}`, { exit: 1 });
        return;
      }
      if (!parsed.userId || typeof parsed.userId !== 'string') {
        this.error(`Server response missing userId: ${response.body}`, { exit: 1 });
        return;
      }
      this.log(parsed.userId);
      return;
    }

    if (response.status === 404) {
      let errorMessage = 'Session is not associated with a WeCom user in this workspace.';
      try {
        const parsed = JSON.parse(response.body) as { error?: string; message?: string };
        errorMessage = parsed.message || parsed.error || errorMessage;
      } catch {
        // keep default message
      }
      console.error(`Failed to resolve current user: ${errorMessage}`);
      process.exit(2);
    }

    let errorMessage: string;
    try {
      const parsed = JSON.parse(response.body) as { error?: string; message?: string };
      errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = `HTTP ${response.status}: ${response.body}`;
    }

    console.error(`Failed to resolve current user: ${errorMessage}`);
    process.exit(3);
  }
}
