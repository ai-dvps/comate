import crypto from 'node:crypto';

const DEFAULT_MCP_CONFIG_ENDPOINT =
  'https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_mcp_config';

export interface McpConfigItem {
  url?: string;
  transport_type?: string;
  is_authed?: boolean;
  biz_type?: string;
}

interface GetMcpConfigResponse {
  errcode: number;
  errmsg?: string;
  list?: McpConfigItem[];
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpClientOptions {
  mcpConfigEndpoint?: string;
  userAgent?: string;
}

/**
 * Minimal WeCom MCP-over-HTTP client.
 *
 * Mirrors the Rust `wecom-cli` flow:
 * 1. Discover the per-category MCP URL via a signed `get_mcp_config` call.
 * 2. Send JSON-RPC 2.0 `tools/call` requests to that URL.
 * 3. Unwrap the inner business JSON from `result.content[0].text`.
 */
export class WeComMcpClient {
  private cache = new Map<string, McpConfigItem[]>();
  private mcpConfigEndpoint: string;
  private userAgent: string;

  constructor(options: McpClientOptions = {}) {
    this.mcpConfigEndpoint = options.mcpConfigEndpoint ?? DEFAULT_MCP_CONFIG_ENDPOINT;
    this.userAgent = options.userAgent ?? 'wecom-cli/0.2.0';
  }

  /**
   * Call a JSON-RPC tool and return the parsed business JSON payload.
   *
   * Transport/protocol errors throw. Business errors (errcode != 0 inside the
   * unwrapped text) are returned as-is so the caller can forward them.
   */
  async callJsonTool(
    botId: string,
    botSecret: string,
    category: string,
    method: string,
    args: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<Record<string, unknown>> {
    const params = { name: method, arguments: args };
    const response = await this.send(botId, botSecret, category, 'tools/call', params, timeoutMs);

    const content = (response?.result as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content) || content.length !== 1) {
      throw new Error('Malformed MCP response: missing result.content[0]');
    }

    const item = content[0] as Record<string, unknown> | undefined;
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      throw new Error('Malformed MCP response: content[0] is not text');
    }

    try {
      return JSON.parse(item.text) as Record<string, unknown>;
    } catch {
      throw new Error('Malformed MCP response: content[0].text is not valid JSON');
    }
  }

  /** Clear the in-memory MCP config cache for the given bot (or all bots if omitted). */
  clearCache(botId?: string): void {
    if (botId) {
      this.cache.delete(botId);
    } else {
      this.cache.clear();
    }
  }

  private async send(
    botId: string,
    botSecret: string,
    category: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const mcpUrl = await this.getMcpUrl(botId, botSecret, category);

    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: genReqId('mcp_rpc'),
      method,
      params,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MCP request failed (HTTP ${response.status})`);
      }

      const res = (await response.json()) as Record<string, unknown>;
      const error = res?.error as Record<string, unknown> | undefined;
      const errorCode = error?.code;
      if (typeof errorCode === 'number' && errorCode !== 0) {
        throw new Error(`MCP protocol error (code=${errorCode}): ${JSON.stringify(error)}`);
      }

      return res;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`MCP request timed out (${timeoutMs}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async getMcpUrl(botId: string, botSecret: string, category: string): Promise<string> {
    let list = this.cache.get(botId);
    if (!list) {
      const resp = await this.fetchMcpConfig(botId, botSecret);
      list = resp.list ?? [];
      this.cache.set(botId, list);
    }

    const target = list.find((item) => item.biz_type === category);
    if (!target) {
      throw new Error(`MCP config for category "${category}" not found`);
    }
    if (!target.url) {
      throw new Error(`MCP config for category "${category}" has empty URL`);
    }
    return target.url;
  }

  private async fetchMcpConfig(botId: string, botSecret: string): Promise<GetMcpConfigResponse> {
    const time = Math.floor(Date.now() / 1000);
    const nonce = genReqId('mcp');
    const signature = sign(botSecret, botId, time, nonce);

    const request = {
      bot_id: botId,
      time,
      nonce,
      signature,
      bind_source: 1, // Interactive
      cli_version: this.userAgent,
    };

    const response = await fetch(this.mcpConfigEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch MCP config (HTTP ${response.status})`);
    }

    const resp = (await response.json()) as GetMcpConfigResponse;
    if (resp.errcode !== 0) {
      throw new Error(
        `Failed to fetch MCP config (errcode=${resp.errcode}): ${resp.errmsg ?? 'unknown error'}`,
      );
    }
    if (!resp.list) {
      throw new Error('MCP config list is empty');
    }
    return resp;
  }
}

/**
 * Compute the request signature.
 *
 * Algorithm: `sha256_hex(secret + bot_id + time + nonce)` using standard
 * zero-padded lowercase hex encoding.
 */
export function sign(secret: string, botId: string, time: number, nonce: string): string {
  const input = `${secret}${botId}${time}${nonce}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Generate a request ID in the format `{prefix}_{timestamp_ms}_{random_hex}`. */
function genReqId(prefix: string): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${timestamp}_${random}`;
}
