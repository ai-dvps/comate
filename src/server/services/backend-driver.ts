/**
 * BackendDriver — the seam between the backend-agnostic session core
 * (SessionRuntime) and a concrete agent runtime (KTD-1).
 *
 * The core owns the approval lifecycle, question stepper, timeouts, event
 * fan-out, and session-backend locking. A driver provides only the runtime
 * transport: create a streaming query, and hand back its handle for
 * interrupt / control probes. Events crossing the seam use the established
 * internal message model (SDKMessage-shaped): the claude path passes it
 * through unchanged, and the opencode adapter (U4) maps its native events
 * into the same shape — clients and renderers never branch on backend.
 */

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SdkClient } from './sdk-client.js';
import type { BackendId } from './agent-backends.js';

export interface BackendDriver {
  readonly backendId: BackendId;
  /**
   * Register a turn before it enters the shared input iterator. Backends with
   * an asynchronous transport boundary resolve only after that transport has
   * accepted the turn; synchronous backends can omit this hook.
   */
  prepareAdmission?(clientTurnId: string): Promise<void>;
  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> };
}

export class ClaudeBackendDriver implements BackendDriver {
  readonly backendId = 'claude' as const;

  constructor(private readonly sdkClient: SdkClient) {}

  createStreamingQuery(
    input: AsyncIterable<SDKUserMessage>,
    options: Options,
  ): { query: Query; messages: AsyncGenerator<SDKMessage> } {
    return this.sdkClient.createStreamingQuery(input, options);
  }
}
