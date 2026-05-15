import {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  Options,
  SDKMessage,
  ListSessionsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  SessionMutationOptions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

export interface QueryResult {
  query: Query;
  messages: AsyncGenerator<SDKMessage>;
}

export class SdkClient {
  createQuery(prompt: string, options: Options): QueryResult {
    const q = query({ prompt, options });

    async function* messageGenerator(): AsyncGenerator<SDKMessage> {
      for await (const msg of q) {
        yield msg;
      }
    }

    return { query: q, messages: messageGenerator() };
  }

  async listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
    return listSessions(options);
  }

  async getSessionInfo(
    sessionId: string,
    options?: GetSessionInfoOptions,
  ): Promise<SDKSessionInfo | undefined> {
    return getSessionInfo(sessionId, options);
  }

  async getSessionMessages(
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ): Promise<SessionMessage[]> {
    return getSessionMessages(sessionId, options);
  }

  async renameSession(
    sessionId: string,
    title: string,
    options?: SessionMutationOptions,
  ): Promise<void> {
    return renameSession(sessionId, title, options);
  }

  async deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void> {
    return deleteSession(sessionId, options);
  }
}

export {
  type Query,
  type Options,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
  type ListSessionsOptions,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type SessionMutationOptions,
};
