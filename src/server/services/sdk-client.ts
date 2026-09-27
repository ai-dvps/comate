import {
  query,
  listSessions,
  listSubagents,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  renameSession,
  forkSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  ListSessionsOptions,
  ListSubagentsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions,
  SessionMutationOptions,
  SDKSessionInfo,
  SessionMessage,
  ForkSessionOptions,
  ForkSessionResult,
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

/** Upper bound for waiting on the system/init frame during command discovery. */
const INIT_FRAME_DRAIN_TIMEOUT_MS = 3_000;

interface InitFrameInfo {
  terminalSlashCommands?: string[];
}

/**
 * Drains the query's message stream up to the system/init frame to capture
 * fields only that frame carries (CLI 2.1.237+: terminal_slash_commands).
 * Never throws — on stream error the caller degrades to no filtering.
 */
async function drainInitFrame(q: Query): Promise<InitFrameInfo | undefined> {
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
        const frame = msg as unknown as Record<string, unknown>;
        const terminal = frame.terminal_slash_commands;
        if (Array.isArray(terminal)) {
          return {
            terminalSlashCommands: terminal.filter(
              (name): name is string => typeof name === 'string',
            ),
          };
        }
        return {};
      }
    }
  } catch {
    // Non-fatal: terminal filtering degrades to absent.
  }
  return undefined;
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
        includePartialMessages: false,
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

  async listSubagents(
    sessionId: string,
    options?: ListSubagentsOptions,
  ): Promise<string[]> {
    return listSubagents(sessionId, options);
  }

  async getSubagentMessages(
    sessionId: string,
    agentId: string,
    options?: GetSubagentMessagesOptions,
  ): Promise<SessionMessage[]> {
    return getSubagentMessages(sessionId, agentId, options);
  }

  async renameSession(
    sessionId: string,
    title: string,
    options?: SessionMutationOptions,
  ): Promise<void> {
    return renameSession(sessionId, title, options);
  }

  async forkSession(
    sessionId: string,
    options?: ForkSessionOptions,
  ): Promise<ForkSessionResult> {
    return forkSession(sessionId, options);
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
      // CLI 2.1.237+ announces terminal-only slash commands on the system/init
      // frame (the initialize control response does not carry them), so drain
      // the message stream alongside the control request. Bounded by a race:
      // a CLI that never emits the frame (or buffers it past iteration start)
      // must not hang command discovery.
      const initFrame = drainInitFrame(q);
      const frameTimer = new Promise<undefined>((resolve) => {
        setTimeout(resolve, INIT_FRAME_DRAIN_TIMEOUT_MS, undefined);
      });
      const [init, frame] = await Promise.all([
        q.initializationResult(),
        Promise.race([initFrame, frameTimer]),
      ]);

      const terminalSlashCommands = frame?.terminalSlashCommands;
      const terminal = new Set(terminalSlashCommands ?? []);
      const commands: SlashCommandDto[] = (init.commands ?? [])
        .filter((c) => !terminal.has(c.name))
        .map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint || undefined,
          aliases: c.aliases,
        }));
      return {
        commands,
        ...(terminalSlashCommands !== undefined && { terminalSlashCommands }),
        ...(typeof init.output_style === 'string' && init.output_style
          ? { outputStyle: init.output_style }
          : {}),
        ...(Array.isArray(init.available_output_styles) &&
        init.available_output_styles.length > 0
          ? { availableOutputStyles: init.available_output_styles }
          : {}),
      };
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
  type ListSubagentsOptions,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type GetSubagentMessagesOptions,
  type SessionMutationOptions,
  type ForkSessionOptions,
  type ForkSessionResult,
  type InitializationResponse,
  type SlashCommandDto,
};
