import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession, CreateSessionInput, UpdateSessionInput } from '../models/session.js';
import type { Workspace } from '../models/workspace.js';
import { store } from '../storage/json-store.js';
import { store as workspaceStore } from '../storage/sqlite-store.js';
import { SdkClient } from './sdk-client.js';

export interface MessageStream {
  messages: AsyncGenerator<SDKMessage>;
  sessionIdPromise: Promise<string | undefined>;
  rawQuery: Query;
}

export class ChatService {
  private sdkClient = new SdkClient();

  // Session management

  async createSession(input: CreateSessionInput): Promise<ChatSession> {
    return store.createSession(input);
  }

  async listSessions(workspaceId: string): Promise<ChatSession[]> {
    return store.listSessions(workspaceId);
  }

  async getSession(id: string): Promise<ChatSession | null> {
    return store.getSession(id);
  }

  async updateSession(id: string, input: UpdateSessionInput): Promise<ChatSession | null> {
    return store.updateSession(id, input);
  }

  async deleteSession(id: string): Promise<boolean> {
    return store.deleteSession(id);
  }

  // Message streaming

  async sendMessage(sessionId: string, message: string): Promise<MessageStream> {
    const session = await store.getSession(sessionId);
    if (!session) {
      throw new ChatError('Session not found', 'SESSION_NOT_FOUND', 404);
    }

    const workspace = await workspaceStore.get(session.workspaceId);
    if (!workspace) {
      throw new ChatError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }

    const options = this.buildSdkOptions(workspace, session.sdkSessionId);
    const { query, messages: rawMessages } = this.sdkClient.createQuery(message, options);

    let resolveSessionId: (value: string | undefined) => void;
    const sessionIdPromise = new Promise<string | undefined>((resolve) => {
      resolveSessionId = resolve;
    });

    const messages = this.wrapStream(rawMessages, resolveSessionId!);

    // Auto-persist SDK session ID when captured
    sessionIdPromise.then((sdkSessionId) => {
      if (sdkSessionId && sdkSessionId !== session.sdkSessionId) {
        store.updateSession(sessionId, { sdkSessionId }).catch((err) => {
          console.error('Failed to persist SDK session ID:', err);
        });
      }
    });

    return { messages, sessionIdPromise, rawQuery: query };
  }

  private buildSdkOptions(workspace: Workspace, sdkSessionId?: string): import('@anthropic-ai/claude-agent-sdk').Options {
    const env: Record<string, string | undefined> = { ...process.env };
    if (workspace.settings.apiKey) {
      env.ANTHROPIC_API_KEY = workspace.settings.apiKey;
    }

    const mcpServers: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig> = {};
    for (const mcp of workspace.mcpServers) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
      };
    }

    const options: import('@anthropic-ai/claude-agent-sdk').Options = {
      cwd: workspace.folderPath,
      env,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      model: workspace.settings.model || undefined,
    };

    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    return options;
  }

  private async *wrapStream(
    stream: AsyncGenerator<SDKMessage>,
    resolveSessionId: (value: string | undefined) => void,
  ): AsyncGenerator<SDKMessage> {
    let captured = false;
    try {
      for await (const msg of stream) {
        if (!captured && msg.session_id) {
          captured = true;
          resolveSessionId(msg.session_id);
        }
        yield msg;
      }
    } finally {
      if (!captured) {
        resolveSessionId(undefined);
      }
    }
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export const chatService = new ChatService();
