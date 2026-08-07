/**
 * browser-shell-client — sidecar side of the KTD-11 control channel plus the
 * handle the browser-service registry holds for natively hosted sessions
 * (shell views and external-CDP targets, U7).
 *
 * The channel is loopback HTTP gated by the per-boot token the shell passed
 * via spawn env; the event stream (SSE) carries the session_lost signals
 * (view-crashed / view-destroyed) that Steel's process exit used to provide
 * (KTD-14: detach → session_lost → one auto-reconnect on next use).
 */

import http from 'node:http';
import {
  buildCdpPageBaseUrl,
  closeShellTarget,
  listCdpTargets,
} from './browser-cdp.js';
import type { SteelExitInfo } from './browser-steel-process.js';
import { diagWarn } from '../utils/diag-logger.js';

export type ControlChannelErrorKind = 'unreachable' | 'http';

export class ControlChannelError extends Error {
  constructor(
    readonly kind: ControlChannelErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ControlChannelError';
  }
}

export interface ShellControlClientOptions {
  port: number;
  token: string;
  host?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateViewResponse {
  partition: string;
  targetMarker: string;
  webPreferences: {
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    preload: string | null;
  };
}

export type ShellViewEvent =
  | { type: 'view-crashed'; sessionId: string; reason?: string }
  | { type: 'view-destroyed'; sessionId: string }
  | { type: 'view-activity'; sessionId: string };

export class ShellControlClient {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShellControlClientOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`http://${this.host}:${this.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      throw new ControlChannelError(
        'unreachable',
        `Shell control channel unreachable at 127.0.0.1:${this.port}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ControlChannelError(
        'http',
        `Control channel ${method} ${path} failed (${res.status}): ` +
          (typeof payload['message'] === 'string' ? payload['message'] : (payload['error'] ?? res.statusText)),
        res.status,
      );
    }
    return payload as T;
  }

  health(): Promise<{ ok: boolean; quitting: boolean }> {
    return this.request('GET', '/health');
  }

  createView(input: { sessionId: string; marker: string }): Promise<CreateViewResponse> {
    return this.request('POST', '/views', input);
  }

  async destroyView(sessionId: string): Promise<boolean> {
    const res = await this.request<{ destroyed?: boolean }>(
      'DELETE',
      `/views/${encodeURIComponent(sessionId)}`,
    );
    return res.destroyed === true;
  }

  wipePartition(sessionId: string): Promise<unknown> {
    return this.request('POST', `/partitions/${encodeURIComponent(sessionId)}/wipe`);
  }

  /**
   * Subscribe to the shell's view event stream. Reconnects with a 1s delay
   * after drops (the stream is the session_lost signal path — a transient
   * reconnect must not lose the subscription permanently). Returns an
   * unsubscribe function.
   */
  subscribeEvents(onEvent: (event: ShellViewEvent) => void): () => void {
    let stopped = false;
    let active: http.ClientRequest | null = null;
    let retry: NodeJS.Timeout | null = null;

    const connect = (): void => {
      if (stopped) return;
      const req = http.get({
        host: this.host,
        port: this.port,
        path: '/events',
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      });
      active = req;
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleRetry();
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf('\n\n');
            const dataLine = frame
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            try {
              onEvent(JSON.parse(dataLine.slice(6)) as ShellViewEvent);
            } catch {
              // Malformed events are dropped, never fatal.
            }
          }
        });
        res.on('end', scheduleRetry);
        res.on('error', scheduleRetry);
      });
      req.on('error', scheduleRetry);
    };

    const scheduleRetry = (): void => {
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 1_000);
      retry.unref?.();
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      active?.destroy();
    };
  }
}

// ---------------------------------------------------------------------------
// ShellViewHandle — the registry handle for a natively hosted session.
// Mirrors SteelProcessHandle's surface so browser-service can drive both
// kinds through one code path (kind discriminates the differences: profile
// locking, port accounting, wipe mechanics).
// ---------------------------------------------------------------------------

export interface ShellViewHandleOptions {
  sessionId: string;
  host?: string;
  /** Debug port of the hosting Chromium (shell or external). */
  debugPort: number;
  targetId: string;
  /** Shell mode: partition + control client for destroy/wipe. */
  partition?: string;
  client?: ShellControlClient;
  /** External mode: throwaway browser context to dispose on stop. */
  browserContextId?: string;
}

export class ShellViewHandle {
  readonly kind = 'shell-view' as const;
  readonly sessionId: string;
  readonly port: number;
  readonly pid = undefined;
  readonly baseUrl: string;
  readonly userDataDir: string;
  private readonly host?: string;
  private readonly targetId: string;
  private readonly partition?: string;
  private readonly client?: ShellControlClient;
  private readonly browserContextId?: string;
  private readonly exitListeners = new Set<(info: SteelExitInfo) => void>();
  private exitInfo: SteelExitInfo | null = null;

  constructor(options: ShellViewHandleOptions) {
    this.sessionId = options.sessionId;
    this.port = options.debugPort;
    this.host = options.host;
    this.targetId = options.targetId;
    this.partition = options.partition;
    this.client = options.client;
    this.browserContextId = options.browserContextId;
    this.baseUrl = buildCdpPageBaseUrl({
      host: options.host ?? '127.0.0.1',
      port: options.debugPort,
      targetId: options.targetId,
    });
    // Informational only — never a filesystem path (partition data belongs to
    // the shell's userData root; the wipeProfile semantic goes through the
    // control channel).
    this.userDataDir = this.partition
      ? `partition:${this.partition}`
      : `cdp-context:${this.browserContextId ?? 'default'}`;
  }

  /** The view/target already exists when the handle is built. */
  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroyView(this.sessionId).catch((err) => {
        diagWarn(`[browser] control-channel view destroy failed for ${this.sessionId}:`, err);
      });
      return;
    }
    await closeShellTarget({
      port: this.port,
      ...(this.host ? { host: this.host } : {}),
      targetId: this.targetId,
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}),
    }).catch((err) => {
      diagWarn(`[browser] external target close failed for ${this.sessionId}:`, err);
    });
  }

  async probeHealth(): Promise<boolean> {
    try {
      const targets = await listCdpTargets({ port: this.port, ...(this.host ? { host: this.host } : {}) });
      return targets.some((target) => target.id === this.targetId);
    } catch {
      return false;
    }
  }

  onExit(listener: (info: SteelExitInfo) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Crash/detach signal into the registry (KTD-14): the SSE event stream
   * (shell mode) or a targetDestroyed watcher (external mode) turns into the
   * same exit fan-out Steel's process death produced.
   */
  notifyExit(info: SteelExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    for (const listener of [...this.exitListeners]) {
      try {
        listener(info);
      } catch {
        // listeners must not break the notification fan-out
      }
    }
    this.exitListeners.clear();
  }

  /** wipeProfile equivalent for native sessions (session/workspace deletion). */
  async wipe(): Promise<void> {
    if (this.client) {
      await this.client.wipePartition(this.sessionId).catch((err) => {
        diagWarn(`[browser] control-channel partition wipe failed for ${this.sessionId}:`, err);
      });
    }
    // External mode: the throwaway browser context is disposed on stop() —
    // nothing persists to wipe.
  }
}
