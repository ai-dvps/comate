/**
 * Spike: minimal opencode REST + SSE client.
 *
 * Purpose: validate ce-pov's Trial verdict — opencode as an alternative agent
 * runtime for environments where Claude Code is disallowed. This module
 * mirrors the shape of `sdk-client.ts` (the Claude Agent SDK wrapper) so the
 * two integration styles can be compared directly:
 *
 *   sdk-client.ts        → query() over a stdio subprocess protocol
 *   opencode-client.ts   → spawn `opencode serve`, then REST + SSE over HTTP
 *
 * Deliberately dependency-free (global fetch, no @opencode-ai/sdk) so the
 * spike measures the raw protocol surface. A production integration could
 * swap the REST layer for the published OpenAPI-generated SDK.
 *
 * Spike scope: do not wire into chat-service. See scripts/spike-opencode.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { diagLog } from '../utils/diag-logger.js';

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

export interface OpencodeServerHandle {
  url: string;
  proc: ChildProcess;
  dispose: () => void;
}

export interface SpawnOpencodeServerOptions {
  /** Path to the opencode binary; defaults to `opencode` on PATH. */
  binaryPath?: string;
  hostname?: string;
  port?: number;
  /**
   * Working directory for the server process. opencode scopes sessions,
   * events, and storage per project directory, so spawn the server rooted at
   * the workspace you intend to drive.
   */
  cwd?: string;
  /** Extra env merged over process.env (e.g. XDG_DATA_HOME for isolation). */
  env?: NodeJS.ProcessEnv;
  /** Serialized into OPENCODE_CONFIG_CONTENT (permission rules, model, ...). */
  config?: Record<string, unknown>;
  timeoutMs?: number;
}

/** Matches the readiness line printed by `opencode serve`. */
export const OPENCODE_LISTENING_RE = /opencode server listening on (https?:\/\/\S+)/;

export const buildOpencodeServeArgs = (
  options: Pick<SpawnOpencodeServerOptions, 'hostname' | 'port'>,
): string[] => [
  'serve',
  `--hostname=${options.hostname ?? '127.0.0.1'}`,
  `--port=${options.port ?? 0}`,
];

export const buildOpencodeServeEnv = (
  options: Pick<SpawnOpencodeServerOptions, 'env' | 'config'>,
): NodeJS.ProcessEnv => ({
  ...process.env,
  ...options.env,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
});

export function spawnOpencodeServer(
  options: SpawnOpencodeServerOptions = {},
): Promise<OpencodeServerHandle> {
  const binary = options.binaryPath ?? 'opencode';
  const args = buildOpencodeServeArgs(options);
  const env = buildOpencodeServeEnv(options);
  const timeoutMs = options.timeoutMs ?? 20_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let stderrTail = '';

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `opencode serve did not report a listening URL within ${timeoutMs}ms. ` +
            `stdout tail: ${buffer.slice(-300)} | stderr tail: ${stderrTail.slice(-300)}`,
        ),
      );
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(OPENCODE_LISTENING_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        diagLog(`[opencode-client] server ready at ${match[1]} (pid=${proc.pid})`);
        resolve({
          url: match[1],
          proc,
          dispose: () => {
            proc.kill();
          },
        });
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString();
    });
    proc.on('error', (err) => fail(new Error(`failed to spawn opencode: ${err.message}`)));
    proc.on('exit', (code) => {
      fail(
        new Error(
          `opencode serve exited early (code=${code}). stderr tail: ${stderrTail.slice(-300)}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// REST types (subset of the opencode v1 HTTP API)
// ---------------------------------------------------------------------------

export interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpencodeSession {
  id: string;
  title?: string;
  directory: string;
  parentID?: string;
  time: { created: number; updated: number };
}

export type OpencodePermissionReply = 'once' | 'always' | 'reject';

/**
 * v1 permission request. NOTE: carries no tool `input` field — the input
 * lives on the corresponding tool part (join via messageID/callID), and the
 * reply vocabulary has no "approve with modified input" variant.
 */
export interface OpencodePermissionRequest {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export interface OpencodePart {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface OpencodeMessage {
  info: { id: string; role: string; time: { created: number } };
  parts: OpencodePart[];
}

export interface OpencodeTodo {
  content: string;
  status: string;
  priority?: string;
  id?: string;
}

export interface OpencodePromptInput {
  text: string;
  model?: OpencodeModelRef;
  agent?: string;
  system?: string;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

const ocRequest = async <T>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; directory?: string } = {},
): Promise<T> => {
  const url = new URL(path, baseUrl);
  if (options.directory) url.searchParams.set('directory', options.directory);
  const res = await fetch(url, {
    method,
    headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`opencode ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
};

export class OpencodeRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly directory?: string,
  ) {}

  static fromHandle(handle: OpencodeServerHandle, directory?: string): OpencodeRestClient {
    return new OpencodeRestClient(handle.url, directory);
  }

  listSessions(): Promise<OpencodeSession[]> {
    return ocRequest(this.baseUrl, 'GET', '/session', { directory: this.directory });
  }

  createSession(title?: string): Promise<OpencodeSession> {
    return ocRequest(this.baseUrl, 'POST', '/session', {
      body: title ? { title } : {},
      directory: this.directory,
    });
  }

  getSessionMessages(sessionId: string): Promise<OpencodeMessage[]> {
    return ocRequest(this.baseUrl, 'GET', `/session/${sessionId}/message`, {
      directory: this.directory,
    });
  }

  promptAsync(sessionId: string, input: OpencodePromptInput): Promise<void> {
    return ocRequest(this.baseUrl, 'POST', `/session/${sessionId}/prompt_async`, {
      body: {
        parts: [{ type: 'text', text: input.text }],
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.system ? { system: input.system } : {}),
      },
      directory: this.directory,
    });
  }

  replyPermission(
    sessionId: string,
    permissionId: string,
    response: OpencodePermissionReply,
  ): Promise<void> {
    return ocRequest(
      this.baseUrl,
      'POST',
      `/session/${sessionId}/permissions/${permissionId}`,
      { body: { response }, directory: this.directory },
    );
  }

  abortSession(sessionId: string): Promise<boolean> {
    return ocRequest(this.baseUrl, 'POST', `/session/${sessionId}/abort`, {
      directory: this.directory,
    });
  }

  forkSession(sessionId: string): Promise<OpencodeSession> {
    return ocRequest(this.baseUrl, 'POST', `/session/${sessionId}/fork`, {
      body: {},
      directory: this.directory,
    });
  }

  listChildSessions(sessionId: string): Promise<OpencodeSession[]> {
    return ocRequest(this.baseUrl, 'GET', `/session/${sessionId}/children`, {
      directory: this.directory,
    });
  }

  getTodos(sessionId: string): Promise<OpencodeTodo[]> {
    return ocRequest(this.baseUrl, 'GET', `/session/${sessionId}/todo`, {
      directory: this.directory,
    });
  }
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

export interface OpencodeEventEnvelope {
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Incremental SSE parser: feed arbitrary string chunks, get back every
 * complete `data: <json>` event. Pure — unit-tested without a server.
 */
export class SseParser {
  private buffer = '';

  feed(chunk: string): OpencodeEventEnvelope[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: OpencodeEventEnvelope[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          events.push(JSON.parse(data) as OpencodeEventEnvelope);
        } catch {
          diagLog(`[opencode-client] dropping unparseable SSE frame: ${data.slice(0, 120)}`);
        }
      }
      boundary = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}

export const subscribeOpencodeEvents = async (
  baseUrl: string,
  onEvent: (event: OpencodeEventEnvelope) => void,
  options: { signal?: AbortSignal; directory?: string } = {},
): Promise<void> => {
  const url = new URL('/event', baseUrl);
  // Events are scoped per project instance; without this, the subscription
  // silently attaches to the server's cwd instance and misses everything.
  if (options.directory) url.searchParams.set('directory', options.directory);
  const res = await fetch(url, {
    signal: options.signal,
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`opencode GET /event → ${res.status}`);
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
      onEvent(event);
    }
  }
};

// ---------------------------------------------------------------------------
// Part mapping (condition-2 fidelity probe)
// ---------------------------------------------------------------------------

/**
 * Normalized target shape — intentionally structural (matches Comate's
 * `MessagePart` in src/server/types/message.ts) without importing it, so the
 * spike stays free of the claude-agent-sdk type dependency that file carries.
 */
export type MappedPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; state: 'streaming' | 'complete' }
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: unknown;
      state: 'streaming' | 'complete';
    }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { type: 'unmapped'; partType: string; reason: string };

interface ToolPartState {
  status?: string;
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
}

/**
 * Map one opencode part to zero or more normalized parts. A completed tool
 * part yields both tool_use and tool_result (mirroring how the claude path
 * separates the two blocks).
 */
export const mapOpencodePart = (part: OpencodePart): MappedPart[] => {
  switch (part.type) {
    case 'text':
      return [{ type: 'text', text: String(part.text ?? '') }];
    case 'reasoning':
      return [{ type: 'thinking', text: String(part.text ?? ''), state: 'complete' }];
    case 'tool': {
      const state = (part.state ?? {}) as ToolPartState;
      const toolUseId = String(part.callID ?? part.id);
      const toolName = String(part.tool ?? 'unknown');
      if (state.status === 'completed') {
        return [
          { type: 'tool_use', toolUseId, toolName, input: state.input, state: 'complete' },
          {
            type: 'tool_result',
            toolUseId,
            output: state.output ?? '',
            isError: false,
          },
        ];
      }
      if (state.status === 'error') {
        return [
          { type: 'tool_use', toolUseId, toolName, input: state.input, state: 'complete' },
          {
            type: 'tool_result',
            toolUseId,
            output: state.error ?? '',
            isError: true,
          },
        ];
      }
      // pending / running
      return [
        { type: 'tool_use', toolUseId, toolName, input: state.input, state: 'streaming' },
      ];
    }
    case 'subtask':
      return [
        {
          type: 'unmapped',
          partType: 'subtask',
          reason: 'subagent invocation; opencode exposes subagent work as child sessions (GET /session/{id}/children)',
        },
      ];
    case 'step-start':
    case 'step-finish':
    case 'snapshot':
    case 'patch':
    case 'retry':
    case 'compaction':
    case 'agent':
    case 'file':
      return [
        {
          type: 'unmapped',
          partType: part.type,
          reason: 'opencode-internal lifecycle part; no Comate render target needed',
        },
      ];
    default:
      return [
        { type: 'unmapped', partType: part.type, reason: 'unknown part type — fidelity gap' },
      ];
  }
};
