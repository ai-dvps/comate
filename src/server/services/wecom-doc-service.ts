import type { Workspace } from '../models/workspace.js';

export class WeComDocService {
  /**
   * Call a WeCom document REST API tool for the given workspace.
   *
   * The exact WeCom REST client (token acquisition, qyapi.weixin.qq.com calls)
   * will be built in a follow-up iteration. For now this is a placeholder that
   * acknowledges the call and returns a success response.
   *
   * @param workspace - The workspace whose wecomBotId/wecomBotSecret will be used.
   * @param tool      - The WeCom doc API tool name (e.g. "get-doc-content").
   * @param params    - Request body parameters forwarded from the HTTP route.
   */
  async callTool(
    workspace: Workspace,
    tool: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: Record<string, any>,
  ): Promise<Record<string, unknown>> {
    const botId = workspace.settings.wecomBotId;
    const botSecret = workspace.settings.wecomBotSecret;

    // This will be replaced with actual WeCom REST calls once the client is built.
    void botId;
    void botSecret;
    void tool;
    void params;

    return {
      errcode: 0,
      errmsg: 'ok',
      placeholder: true,
    };
  }
}

export const wecomDocService = new WeComDocService();
