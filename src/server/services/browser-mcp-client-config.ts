export interface BrowserMcpClientConnection {
  readonly url: string;
  readonly headers: Readonly<{ Authorization: string }>;
}

/** One backend-neutral authenticated HTTP connection; adapters add only their dialect's type tag. */
export function buildBrowserMcpClientConnection(baseUrl: string, sessionId: string, taskToken: string): BrowserMcpClientConnection {
  if (!sessionId || /[/?#]/.test(sessionId) || !taskToken || /\s/.test(taskToken)) {
    throw new Error('invalid_browser_mcp_client_connection');
  }
  return Object.freeze({
    url: `${baseUrl.replace(/\/+$/, '')}/mcp/browser/${sessionId}`,
    headers: Object.freeze({ Authorization: `Bearer ${taskToken}` }),
  });
}
