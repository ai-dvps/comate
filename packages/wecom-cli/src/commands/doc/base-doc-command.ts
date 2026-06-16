import { BaseCommand } from '../base.js';
import { postJson } from '../../lib/http.js';

export abstract class BaseDocCommand extends BaseCommand {
  protected async callDocTool(toolName: string, params: Record<string, unknown>): Promise<void> {
    const context = this.loadContext();
    if (!context.workspaceId) {
      this.error(
        "This workspace's WeCom context file is missing workspaceId.\n" +
          'Please reconnect the WeCom bot for this workspace to update the context file.',
        { exit: 1 }
      );
    }

    const endpointUrl = `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom/doc/${toolName}`;

    try {
      const response = await postJson(endpointUrl, params);
      if (response.status === 200) {
        this.log(response.body);
        return;
      }
      // Server error responses
      let errorMessage: string;
      try {
        const parsed = JSON.parse(response.body) as { error?: string; message?: string };
        errorMessage = parsed.message || parsed.error || `HTTP ${response.status}`;
      } catch {
        errorMessage = `HTTP ${response.status}: ${response.body}`;
      }
      this.error(`Failed: ${errorMessage}`, { exit: 3 });
    } catch (err) {
      // Network failure (connection refused, DNS, timeout)
      const message = err instanceof Error ? err.message : String(err);
      this.error(`Network error: ${message}`, { exit: 4 });
    }
  }
}
