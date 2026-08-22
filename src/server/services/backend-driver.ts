/**
 * BackendDriver — the seam between the backend-agnostic session core
 * (SessionRuntime) and a concrete agent runtime (KTD-1).
 *
 * The core owns the approval lifecycle, question stepper, timeouts, event
 * fan-out, and session-backend locking. A driver provides only the runtime
 * transport: create a streaming query, and hand back its handle for
 * interrupt / control probes. The legacy Claude/OpenCode transports still
 * normalize through SDKMessage while Codex-facing service facets use the
 * backend-neutral contracts below. Keeping that compatibility bridge here
 * prevents Anthropic types from leaking into the registry and product policy.
 */

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SdkClient } from './sdk-client.js';
import type { BackendId } from './agent-backends.js';

/** Backend-neutral identity for a persisted runtime conversation. */
export interface BackendSessionRef {
  backend: BackendId;
  sessionId: string;
}

/** Input accepted by a backend session independent of its wire protocol. */
export interface BackendTurnInput {
  clientTurnId: string;
  content: unknown;
}

/** Control operations exposed by a live backend session. */
export interface BackendSessionControl {
  interrupt(): Promise<unknown>;
  close(): void;
  stopTask?(taskId: string): Promise<unknown>;
  getContextUsage?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
}

/** A normalized event envelope can carry protocol-neutral UI events directly. */
export interface BackendAgentEvent<TEvent = unknown> {
  id?: string;
  event: TEvent;
}

export interface BackendDriver {
  readonly backendId: BackendId;
  /** Whether the shared UI may stop one background task without closing the session. */
  readonly supportsIndividualTaskStop?: boolean;
  /**
   * Register a turn before it enters the shared input iterator. Backends with
   * an asynchronous transport boundary resolve only after that transport has
   * accepted the turn; synchronous backends can omit this hook.
   */
  prepareAdmission?(clientTurnId: string): Promise<void>;
  /** Backend-owned content normalization; shared runtime never branches on backend id. */
  prepareUserContent?(content: unknown): unknown;
  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> };
}

export class ClaudeBackendDriver implements BackendDriver {
  readonly backendId = 'claude' as const;
  readonly supportsIndividualTaskStop = true;

  constructor(private readonly sdkClient: SdkClient) {}

  prepareUserContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (
        typeof block !== 'object' || block === null ||
        !('type' in block) || block.type !== 'image' ||
        !('name' in block)
      ) return block;
      const withoutDisplayName = { ...block } as Record<string, unknown>;
      delete withoutDisplayName.name;
      return withoutDisplayName;
    });
  }

  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> } {
    return this.sdkClient.createStreamingQuery(input, options);
  }
}
