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
  SDKUserMessage,
  PermissionResult,
  ListSessionsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  SessionMutationOptions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  InitializationResponse,
  SlashCommandDto,
} from '../types/initialization.js';

export interface QueryResult {
  query: Query;
  messages: AsyncGenerator<SDKMessage>;
}

function wrapQuery(q: Query): AsyncGenerator<SDKMessage> {
  return (async function* (): AsyncGenerator<SDKMessage> {
    for await (const msg of q) {
      yield msg;
    }
  })();
}

export class SdkClient {
  createQuery(prompt: string, options: Options): QueryResult {
    const q = query({ prompt, options });
    return { query: q, messages: wrapQuery(q) };
  }

  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): QueryResult {
    const q = query({
      prompt: input,
      options: {
        ...options,
        includePartialMessages: true,
        toolConfig: {
          askUserQuestion: { previewFormat: 'html' },
        },
      },
    });

    return { query: q, messages: wrapQuery(q) };
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

  async fetchInitialization(options: Options): Promise<InitializationResponse> {
    const empty: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
        };
      },
    };

    const q = query({ prompt: empty, options });
    try {
      const init = await q.initializationResult();
      const commands: SlashCommandDto[] = (init.commands ?? []).map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint || undefined,
        aliases: c.aliases,
      }));
      return { commands };
    } finally {
      try {
        q.close();
      } catch {
        // Ignore teardown errors
      }
    }
  }
}

export {
  type Query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type SDKSessionInfo,
  type SessionMessage,
  type ListSessionsOptions,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type SessionMutationOptions,
  type InitializationResponse,
  type SlashCommandDto,
};
