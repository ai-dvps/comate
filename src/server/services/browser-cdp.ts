import WebSocket from 'ws';
import type { RawAxNode } from './browser-page-model.js';

/**
 * browser-cdp — minimal Chrome DevTools Protocol client over a WebSocket
 * (KTD-3). Talks to the per-session Steel process's root WS endpoint, which
 * proxies Chromium's browser-level CDP socket (vendored Steel:
 * build/plugins/browser-socket/browser-socket.js falls through unmatched
 * upgrade URLs to cdpService.proxyWebSocket).
 *
 * Why raw CDP over puppeteer-core: the distiller's hard parts (readability
 * extraction, ref minting, TOCTOU form reads) are custom in-page scripts
 * either way; puppeteer-core would add ~8MB of dependency for a thin
 * Page.evaluate/Page.screenshot veneer, and its deprecated accessibility
 * snapshot API does not map to our ref discipline. `ws` is already a
 * dependency (sidecar WS server), so this client adds zero new runtime deps.
 */

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method?: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

interface PendingCommand {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type CdpEventListener = (params: unknown) => void;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 45_000;
const LOAD_EVENT_TIMEOUT_MS = 10_000;

export interface CdpConnectionOptions {
  commandTimeoutMs?: number;
  /**
   * Total budget (ms) to keep retrying the CDP connect+attach across the Steel
   * cold-start window. Steel reports /v1/health=200 before Chrome's CDP
   * endpoint accepts WebSocket upgrades (~1–2s gap on a cold start), so the
   * first connect after a fresh spawn races Chrome readiness and fails with
   * "socket hang up". Default 10s — well beyond the observed cold-start.
   */
  connectReadyTimeoutMs?: number;
  /** Delay between cold-start connect retries. Default 300ms. */
  connectRetryIntervalMs?: number;
}

/** Raw CDP transport: id-matched commands + method-keyed event listeners. */
export class CdpConnection {
  private readonly ws: WebSocket;
  private readonly commandTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventListeners = new Map<string, Set<CdpEventListener>>();
  private readonly closeListeners = new Set<() => void>();
  private closedFlag = false;

  private constructor(ws: WebSocket, options: CdpConnectionOptions) {
    this.ws = ws;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    ws.on('close', () => this.markClosed());
    ws.on('error', () => this.markClosed());
  }

  static connect(wsUrl: string, options: CdpConnectionOptions = {}): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: 5_000,
        maxPayload: 64 * 1024 * 1024,
        // Loopback-only peer; permessage-deflate just burns CPU.
        perMessageDeflate: false,
      });
      const connection = new CdpConnection(ws, options);
      ws.once('open', () => resolve(connection));
      ws.once('error', (err) => reject(new CdpError(`CDP websocket connect failed: ${err.message}`)));
    });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closedFlag) {
      return Promise.reject(new CdpError(`CDP connection closed (method ${method})`, method));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`, method));
      }, method === 'Page.navigate' ? NAVIGATE_TIMEOUT_MS : this.commandTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new CdpError(`CDP send failed for ${method}: ${err.message}`, method));
        }
      });
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    let listeners = this.eventListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.closedFlag) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    if (this.closedFlag) return;
    try {
      this.ws.close();
    } catch {
      // Already torn down.
    }
    this.markClosed();
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new CdpError(
            `CDP ${pending.method} failed: ${error.message ?? 'unknown error'}`,
            pending.method,
            error.code,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      const listeners = this.eventListeners.get(message.method);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(message.params);
        } catch {
          // Event listeners must not break the transport.
        }
      }
    }
  }

  private markClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(`CDP connection closed (method ${pending.method})`, pending.method));
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        // Close listeners must not break teardown.
      }
    }
  }
}

/**
 * Page-level API the browser tools drive. Implemented over a flattened
 * Target session so commands address one page; the ref/TOCTOU machinery
 * only needs evaluate + AX tree + navigate + screenshot + backend-node click.
 */
export interface SteelCdpSession {
  readonly closed: boolean;
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  getFullAXTree(): Promise<RawAxNode[]>;
  clickBackendNode(backendNodeId: number): Promise<void>;
  /** JPEG base64 (bare, no data-URL prefix) for MCP image blocks. */
  captureScreenshot(): Promise<string>;
  /**
   * Browser-profile cookie write (Network.setCookies) — the remembered-site
   * injection path; MUST run before the first navigation so the initial
   * request already carries the cookies (U8).
   */
  setCookies(cookies: Array<Record<string, unknown>>): Promise<void>;
  /**
   * Register a script to run before page scripts on every new document
   * (Page.addScriptToEvaluateOnNewDocument) — remembered-site web-storage
   * injection (U8). Tighter than Steel's own framenavigated race: the script
   * lands before any page JavaScript can read localStorage.
   */
  evaluateOnNewDocument(expression: string): Promise<void>;
  onClose(listener: () => void): void;
  close(): void;
}

interface TargetInfo {
  targetId: string;
  type: string;
}

interface EvaluateResult {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const CLICK_FN = `function () {
  try { this.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  this.click();
  return true;
}`;

class SteelCdpSessionImpl implements SteelCdpSession {
  private constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
  ) {}

  static async attach(connection: CdpConnection): Promise<SteelCdpSessionImpl> {
    const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const page = targetInfos.find((target) => target.type === 'page');
    if (!page) {
      throw new CdpError('No page target available in Steel browser', 'Target.getTargets');
    }
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    const session = new SteelCdpSessionImpl(connection, sessionId);
    // Events are best-effort: navigation wait uses loadEventFired, but ref
    // invalidation never relies on events (docId/epoch polling covers it).
    await connection.send('Page.enable', {}, sessionId).catch(() => undefined);
    return session;
  }

  get closed(): boolean {
    return this.connection.closed;
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }

  close(): void {
    this.connection.close();
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
      throw new CdpError(`In-page evaluation failed: ${detail}`, 'Runtime.evaluate');
    }
    return result.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    const loadFired = new Promise<void>((resolve) => {
      const off = this.connection.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, LOAD_EVENT_TIMEOUT_MS).unref?.();
    });
    const response = await this.connection.send<{ errorText?: string }>(
      'Page.navigate',
      { url },
      this.sessionId,
    );
    if (response.errorText) {
      throw new CdpError(`Navigation failed: ${response.errorText}`, 'Page.navigate');
    }
    await loadFired;
  }

  async getFullAXTree(): Promise<RawAxNode[]> {
    const result = await this.connection.send<{ nodes: RawAxNode[] }>(
      'Accessibility.getFullAXTree',
      {},
      this.sessionId,
    );
    return result.nodes ?? [];
  }

  async clickBackendNode(backendNodeId: number): Promise<void> {
    const { object } = await this.connection.send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId,
    );
    if (!object.objectId) {
      throw new CdpError('Failed to resolve element for click', 'DOM.resolveNode');
    }
    try {
      await this.connection.send(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: CLICK_FN, returnByValue: true },
        this.sessionId,
      );
    } finally {
      await this.connection
        .send('Runtime.releaseObject', { objectId: object.objectId }, this.sessionId)
        .catch(() => undefined);
    }
  }

  async captureScreenshot(): Promise<string> {
    const result = await this.connection.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70 },
      this.sessionId,
    );
    return result.data;
  }

  async setCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    await this.connection.send('Network.enable', {}, this.sessionId).catch(() => undefined);
    await this.connection.send('Network.setCookies', { cookies }, this.sessionId);
  }

  async evaluateOnNewDocument(expression: string): Promise<void> {
    await this.connection.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: expression },
      this.sessionId,
    );
  }
}

const DEFAULT_CONNECT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_RETRY_INTERVAL_MS = 300;

export interface RetryDuringColdStartOptions {
  budgetMs: number;
  intervalMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retry a CDP connect+attach across the Steel cold-start window. Steel's
 * /v1/health returns 200 (cdpService.isRunning() is true) before Chrome's CDP
 * endpoint accepts WebSocket upgrades — measured at ~1–2s after health on a
 * cold start — so the first connectSteelPage after a fresh spawn races Chrome
 * readiness and fails with "CDP websocket connect failed: socket hang up".
 * Without this, browser-mcp's first navigate fails and the pane stays on
 * about:blank. Bounded retry lets the first tool call wait for Chrome instead.
 *
 * `attempt` is the full connect+attach (both can fail transiently while Chrome
 * boots: the WS handshake hangs up, and Target.getTargets finds no page yet).
 */
export async function retryDuringColdStart<T>(
  attempt: () => Promise<T>,
  opts: RetryDuringColdStartOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.budgetMs;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (now() >= deadline) {
        throw err;
      }
      await sleep(opts.intervalMs);
    }
  }
}

/**
 * Connect to a Steel process's CDP endpoint and attach to its page. Steel
 * exposes the browser-level CDP socket at the root WS path (self-hosted
 * single-session mode — one Steel process per chat session, KTD-1).
 */
export async function connectSteelPage(
  baseUrl: string,
  options: CdpConnectionOptions = {},
): Promise<SteelCdpSession> {
  const wsUrl = `${baseUrl.replace(/^http/i, 'ws')}/`;
  const budgetMs = options.connectReadyTimeoutMs ?? DEFAULT_CONNECT_READY_TIMEOUT_MS;
  const intervalMs = options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS;
  return retryDuringColdStart(
    async () => {
      const connection = await CdpConnection.connect(wsUrl, options);
      try {
        return await SteelCdpSessionImpl.attach(connection);
      } catch (err) {
        connection.close();
        throw err;
      }
    },
    { budgetMs, intervalMs },
  );
}
