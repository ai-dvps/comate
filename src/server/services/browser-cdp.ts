import WebSocket from 'ws';
import type {
  BrowserDocumentIdentity,
  InspectedElement,
  PageExtractionBundle,
  RawAxNode,
  RawPageExtraction,
} from './browser-page-model.js';
import type { BrowserNetworkCaptureTransport, CdpEventEnvelope } from './browser-network-capture.js';
import {
  buildDesktopFingerprint,
  buildFingerprintInitScript,
  parseChromeVersion,
  userAgentOverrideParams,
  type DesktopFingerprint,
} from './browser-fingerprint.js';

/**
 * browser-cdp — minimal Chrome DevTools Protocol client over a WebSocket
 * (KTD-3). Talks to a debug-port Chromium's browser-level CDP socket: the
 * in-shell Electron browser views (KTD-6) or an operator-supplied external
 * endpoint (COMATE_BROWSER_CDP_TARGET, the R8/AE2 fallback).
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

type CdpEventListener = (event: CdpEventEnvelope) => void;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 45_000;
const LOAD_EVENT_TIMEOUT_MS = 10_000;

export interface CdpConnectionOptions {
  commandTimeoutMs?: number;
  /**
   * Total budget (ms) to keep retrying the CDP connect+attach across the
   * cold-start window: a freshly created view/target races Chromium's CDP
   * readiness (~1–2s gap on a cold start), so the first connect can fail
   * transiently with "socket hang up". Default 10s — well beyond the
   * observed cold-start.
   */
  connectReadyTimeoutMs?: number;
  /** Delay between cold-start connect retries. Default 300ms. */
  connectRetryIntervalMs?: number;
}

export type BrowserMutationOutcome =
  | 'not_dispatched'
  | 'dispatched_verified'
  | 'outcome_unknown';

export type BrowserMutationReason =
  | 'target_unavailable'
  | 'target_disabled'
  | 'target_not_visible'
  | 'target_occluded'
  | 'target_frame_mismatch'
  | 'unsupported_target'
  | 'unsupported_input_command'
  | 'dispatch_failed'
  | 'verification_mismatch';

/**
 * Text-free mutation result. It deliberately reports transport/DOM evidence,
 * never business success and never the supplied or resulting field value.
 */
export interface BrowserOperationReceipt {
  outcome: BrowserMutationOutcome;
  dispatchState: 'not_dispatched' | 'dispatched';
  verified: boolean;
  retrySafe: boolean;
  matchesRequested?: boolean;
  normalizedLength?: number;
  reason?: BrowserMutationReason;
  delta: {
    kind: 'none' | 'activation' | 'field';
    changed: boolean;
  };
}

/** Raw CDP transport: id-matched commands + method-keyed event listeners. */
export class CdpConnection {
  private readonly ws: WebSocket;
  private readonly commandTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventListeners = new Map<string, Set<CdpEventListener>>();
  private readonly anyEventListeners = new Set<CdpEventListener>();
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

  /** Subscribe to every event with its flattened target session identity intact. */
  onEvent(listener: CdpEventListener): () => void {
    this.anyEventListeners.add(listener);
    return () => {
      this.anyEventListeners.delete(listener);
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
      const envelope: CdpEventEnvelope = {
        method: message.method,
        params: message.params,
        ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
      };
      const listeners = this.eventListeners.get(message.method);
      for (const listener of [...(listeners ?? []), ...this.anyEventListeners]) {
        try {
          listener(envelope);
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
    this.eventListeners.clear();
    this.anyEventListeners.clear();
    this.closeListeners.clear();
  }
}

/**
 * Page-level API the browser tools drive. Implemented over a flattened
 * Target session so commands address one page; the ref/TOCTOU machinery
 * only needs evaluate + AX tree + navigate + screenshot + backend-node click.
 */
export interface BrowserCdpSession {
  readonly closed: boolean;
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  getFullAXTree(): Promise<RawAxNode[]>;
  clickBackendNode(backendNodeId: number): Promise<BrowserOperationReceipt>;
  fillBackendNode?(backendNodeId: number, text: string): Promise<BrowserOperationReceipt>;
  getDocumentIdentity?(): BrowserDocumentIdentity | null;
  extractPageModel?(expression: string): Promise<PageExtractionBundle>;
  callBackendNode?<T>(backendNodeId: number, functionDeclaration: string): Promise<T | null>;
  /** Resolve an AX-backed ref without accepting an arbitrary selector. */
  inspectBackendNode?(backendNodeId: number, functionDeclaration: string): Promise<InspectedElement | null>;
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
   * injection (U8). The script lands before any page JavaScript can read
   * localStorage (no framenavigated race).
   */
  evaluateOnNewDocument(expression: string): Promise<void>;
  /** Optional so existing page fakes need not emulate raw CDP network traffic. */
  createNetworkCaptureTransport?(): BrowserNetworkCaptureTransport;
  /**
   * Page-scoped cookie read (Network.getCookies for the given URLs) — the
   * native-path session-context export (KTD-12). Optional so existing page
   * fakes need not emulate the Network domain.
   */
  getCookiesForUrls?(urls: string[]): Promise<Array<Record<string, unknown>>>;
  onClose(listener: () => void): void;
  close(): void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

interface EvaluateResult {
  result?: { type?: string; value?: unknown; description?: string; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function isPositivePageExtraction(value: unknown): value is RawPageExtraction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.docId === 'string' &&
    typeof candidate.domEpoch === 'number' &&
    Array.isArray(candidate.forms) &&
    Array.isArray(candidate.standalone) &&
    typeof candidate.contentText === 'string' &&
    typeof candidate.contentTruncated === 'boolean' &&
    Array.isArray(candidate.alerts) &&
    !!candidate.stats && typeof candidate.stats === 'object' && !Array.isArray(candidate.stats);
}

const READ_INTERACTION_STATE_FN = `function () {
  var ariaDisabled = (this.getAttribute && this.getAttribute('aria-disabled') || '').toLowerCase();
  return {
    connected: this.isConnected === true,
    enabled: !this.disabled && ariaDisabled !== 'true'
  };
}`;

const ALLOWED_HIT_TEST_FN = `function (target) {
  return !!target && target.isConnected === true && (this === target || target.contains(this));
}`;

const PREPARE_TEXT_REPLACEMENT_FN = `function () {
  if (this.isConnected !== true) return { editable: false };
  var tag = this.tagName ? this.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea') {
    if (this.disabled || this.readOnly) return { editable: false };
    try { this.setSelectionRange(0, String(this.value == null ? '' : this.value).length); }
    catch (e) { return { editable: false }; }
    return { kind: tag, editable: true };
  }
  var ce = (this.getAttribute && this.getAttribute('contenteditable') || '').toLowerCase();
  var contenteditable = this.isContentEditable === true || ce === '' || ce === 'true' || ce === 'plaintext-only';
  var role = (this.getAttribute && this.getAttribute('role') || '').toLowerCase();
  if (!contenteditable && role !== 'textbox') return { editable: false };
  var selection = this.ownerDocument && this.ownerDocument.getSelection ? this.ownerDocument.getSelection() : null;
  if (!selection) return { editable: false };
  var range = this.ownerDocument.createRange();
  range.selectNodeContents(this);
  selection.removeAllRanges();
  selection.addRange(range);
  return { kind: 'contenteditable', editable: true };
}`;

const VERIFY_TEXT_REPLACEMENT_FN = `function (expected) {
  function normalize(value) { return String(value == null ? '' : value).replace(/\\r\\n?/g, '\\n'); }
  if (this.isConnected !== true) return { matches: false, normalizedLength: 0 };
  var tag = this.tagName ? this.tagName.toLowerCase() : '';
  var actual = tag === 'input' || tag === 'textarea'
    ? this.value
    : (typeof this.innerText === 'string' ? this.innerText : this.textContent);
  actual = normalize(actual);
  expected = normalize(expected);
  return { matches: actual === expected, normalizedLength: actual.length };
}`;

const NATIVE_TEXT_FALLBACK_FN = `function (value) {
  if (this.isConnected !== true) return { ok: false };
  var tag = this.tagName ? this.tagName.toLowerCase() : '';
  if (tag !== 'input' && tag !== 'textarea') return { ok: false };
  var proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!descriptor || !descriptor.set) return { ok: false };
  descriptor.set.call(this, value);
  this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}`;

function notDispatched(reason: BrowserMutationReason): BrowserOperationReceipt {
  return {
    outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: false,
    retrySafe: true, reason, delta: { kind: 'none', changed: false },
  };
}

function outcomeUnknown(kind: 'activation' | 'field'): BrowserOperationReceipt {
  return {
    outcome: 'outcome_unknown', dispatchState: 'dispatched', verified: false,
    retrySafe: false, reason: 'dispatch_failed', delta: { kind, changed: false },
  };
}

function unsupportedCommand(error: unknown): boolean {
  return error instanceof CdpError && (
    error.code === -32601 || /wasn't found|method not found|unknown method/i.test(error.message)
  );
}

class BrowserCdpSessionImpl implements BrowserCdpSession {
  private closedFlag = false;
  private readonly closeListeners = new Set<() => void>();
  private offConnectionClose?: () => void;
  private offTargetDetached?: () => void;
  private readonly lifecycleTeardowns: Array<() => void> = [];
  private documentIdentity: BrowserDocumentIdentity | null = null;
  private documentGeneration = 0;
  private mainFrameId = '';
  private loaderId = '';
  private extractionSequence = 0;

  private constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
    private readonly targetId: string,
  ) {
    this.offConnectionClose = connection.onClose(() => this.markClosed());
    this.offTargetDetached = connection.on('Target.detachedFromTarget', (event) => {
      const detachedSessionId = (event.params as { sessionId?: string }).sessionId;
      if (detachedSessionId === this.sessionId) this.markClosed();
    });
    this.lifecycleTeardowns.push(
      connection.on('Page.frameNavigated', (event) => {
        if (event.sessionId !== this.sessionId) return;
        const frame = (event.params as { frame?: { id?: string; parentId?: string; loaderId?: string } }).frame;
        if (!frame?.id || frame.parentId) return;
        if (this.mainFrameId && (frame.id !== this.mainFrameId || (frame.loaderId && frame.loaderId !== this.loaderId))) {
          this.documentGeneration += 1;
        }
        this.mainFrameId = frame.id;
        if (frame.loaderId) this.loaderId = frame.loaderId;
        this.refreshDocumentIdentity();
      }),
      connection.on('DOM.documentUpdated', (event) => {
        if (event.sessionId !== this.sessionId) return;
        this.documentGeneration += 1;
        this.refreshDocumentIdentity();
      }),
      connection.on('Runtime.executionContextsCleared', (event) => {
        if (event.sessionId !== this.sessionId) return;
        this.documentGeneration += 1;
        this.refreshDocumentIdentity();
      }),
      connection.on('Runtime.executionContextDestroyed', (event) => {
        if (event.sessionId !== this.sessionId) return;
        this.documentGeneration += 1;
        this.refreshDocumentIdentity();
      }),
      connection.on('Inspector.detached', (event) => {
        if (event.sessionId === this.sessionId) this.markClosed();
      }),
    );
  }

  static async attach(connection: CdpConnection): Promise<BrowserCdpSessionImpl> {
    const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const page = targetInfos.find((target) => target.type === 'page');
    if (!page) {
      throw new CdpError('No page target available on the CDP endpoint', 'Target.getTargets');
    }
    return BrowserCdpSessionImpl.attachTo(connection, page.targetId);
  }

  /**
   * Attach to a specific target (flattened). The shell path (KTD-6) selects
   * the per-session browser view's page target from the debug port's target
   * list.
   */
  static async attachTo(connection: CdpConnection, targetId: string): Promise<BrowserCdpSessionImpl> {
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const session = new BrowserCdpSessionImpl(connection, sessionId, targetId);
    await Promise.all([
      connection.send('Page.enable', {}, sessionId).catch(() => undefined),
      connection.send('DOM.enable', {}, sessionId).catch(() => undefined),
      connection.send('Runtime.enable', {}, sessionId).catch(() => undefined),
    ]);
    const frameTree: { frameTree?: { frame?: { id?: string; loaderId?: string } } } = await connection.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>(
      'Page.getFrameTree', {}, sessionId,
    ).catch(() => ({} as { frameTree?: { frame?: { id?: string; loaderId?: string } } }));
    session.mainFrameId = frameTree.frameTree?.frame?.id ?? '';
    session.loaderId = frameTree.frameTree?.frame?.loaderId ?? '';
    session.refreshDocumentIdentity();
    return session;
  }

  get closed(): boolean {
    return this.closedFlag || this.connection.closed;
  }

  onClose(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }
    this.closeListeners.add(listener);
  }

  close(): void {
    this.markClosed();
    this.connection.close();
  }

  private markClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.offConnectionClose?.();
    this.offTargetDetached?.();
    this.offConnectionClose = undefined;
    this.offTargetDetached = undefined;
    for (const off of this.lifecycleTeardowns.splice(0)) off();
    this.documentIdentity = null;
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        // Page lifecycle listeners must not break CDP event dispatch.
      }
    }
    this.closeListeners.clear();
  }

  private refreshDocumentIdentity(): void {
    this.documentIdentity = this.mainFrameId && this.loaderId
      ? {
          targetId: this.targetId,
          sessionId: this.sessionId,
          frameId: this.mainFrameId,
          loaderId: this.loaderId,
          generation: this.documentGeneration,
        }
      : null;
  }

  getDocumentIdentity(): BrowserDocumentIdentity | null {
    return this.closed || !this.documentIdentity ? null : { ...this.documentIdentity };
  }

  async extractPageModel(expression: string): Promise<PageExtractionBundle> {
    const objectGroup = `comate-page-extraction-${this.sessionId}-${++this.extractionSequence}`;
    try {
      const evaluated = await this.connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression, returnByValue: false, awaitPromise: true, includeCommandLineAPI: true, objectGroup },
        this.sessionId,
      );
      if (evaluated.exceptionDetails) throw new CdpError('In-page extraction failed', 'Runtime.evaluate');
      const rootObjectId = evaluated.result?.objectId;
      if (!rootObjectId) throw new CdpError('Page extraction did not return an object handle', 'Runtime.evaluate');

      const properties = await this.connection.send<{
        result?: Array<{ name?: string; value?: { objectId?: string } }>;
      }>('Runtime.getProperties', { objectId: rootObjectId, ownProperties: true }, this.sessionId);
      const identityArrayId = properties.result?.find((property) => property.name === 'identityObjects')?.value?.objectId;
      if (!identityArrayId) throw new CdpError('Page extraction omitted exact element handles', 'Runtime.getProperties');

      const serialized = await this.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        {
          objectId: rootObjectId,
          functionDeclaration: `function () {
            var out = {};
            var keys = Object.keys(this);
            for (var i = 0; i < keys.length; i++) {
              if (keys[i] !== 'identityObjects') out[keys[i]] = this[keys[i]];
            }
            return out;
          }`,
          returnByValue: true,
        },
        this.sessionId,
      );
      const extraction = serialized.result?.value;
      if (!isPositivePageExtraction(extraction)) {
        throw new CdpError('Page extraction returned an invalid positive-shape payload', 'Runtime.callFunctionOn');
      }

      const identityProperties = await this.connection.send<{
        result?: Array<{ name?: string; value?: { objectId?: string } }>;
      }>('Runtime.getProperties', { objectId: identityArrayId, ownProperties: true }, this.sessionId);
      const handles = (identityProperties.result ?? [])
        .filter((property) => /^\d+$/.test(property.name ?? '') && property.value?.objectId)
        .sort((a, b) => Number(a.name) - Number(b.name));
      const backendNodeIds = new Array<number | null>(handles.length);
      const describeConcurrency = 12;
      for (let start = 0; start < handles.length; start += describeConcurrency) {
        const described = await Promise.all(handles.slice(start, start + describeConcurrency).map((handle) =>
          this.connection.send<{ node?: { backendNodeId?: number } }>(
            'DOM.describeNode', { objectId: handle.value!.objectId }, this.sessionId,
          ),
        ));
        for (let offset = 0; offset < described.length; offset += 1) {
          backendNodeIds[start + offset] = described[offset].node?.backendNodeId ?? null;
        }
      }
      return { extraction, backendNodeIds };
    } finally {
      await this.connection.send('Runtime.releaseObjectGroup', { objectGroup }, this.sessionId).catch(() => undefined);
    }
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
      const off = this.connection.on('Page.loadEventFired', (event) => {
        if (event.sessionId !== this.sessionId) return;
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

  async clickBackendNode(backendNodeId: number): Promise<BrowserOperationReceipt> {
    let targetObjectId: string | undefined;
    try {
      const resolved = await this.connection.send<{ object?: { objectId?: string } }>(
        'DOM.resolveNode', { backendNodeId }, this.sessionId,
      );
      targetObjectId = resolved.object?.objectId;
      if (!targetObjectId) return notDispatched('target_unavailable');
      const stateResult = await this.connection.send<EvaluateResult>('Runtime.callFunctionOn', {
        objectId: targetObjectId,
        functionDeclaration: READ_INTERACTION_STATE_FN,
        returnByValue: true,
      }, this.sessionId);
      const state = stateResult.result?.value as { connected?: boolean; enabled?: boolean } | undefined;
      if (!state?.connected) return notDispatched('target_unavailable');
      if (!state.enabled) return notDispatched('target_disabled');

      await this.connection.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, this.sessionId);
      const box = await this.connection.send<{ model?: { content?: number[]; border?: number[] } }>(
        'DOM.getBoxModel', { backendNodeId }, this.sessionId,
      );
      const quad = box.model?.content ?? box.model?.border;
      if (!quad || quad.length < 8 || quad.some((value) => !Number.isFinite(value))) {
        return notDispatched('target_not_visible');
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x = xs.reduce((sum, value) => sum + value, 0) / xs.length;
      const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      if (Math.max(...xs) - Math.min(...xs) <= 0 || Math.max(...ys) - Math.min(...ys) <= 0) {
        return notDispatched('target_not_visible');
      }

      const hit = await this.connection.send<{ backendNodeId?: number; frameId?: string }>(
        'DOM.getNodeForLocation',
        { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false },
        this.sessionId,
      );
      if (hit.frameId && this.mainFrameId && hit.frameId !== this.mainFrameId) {
        return notDispatched('target_frame_mismatch');
      }
      if (typeof hit.backendNodeId !== 'number') return notDispatched('target_occluded');
      if (hit.backendNodeId !== backendNodeId) {
        let hitObjectId: string | undefined;
        try {
          const hitResolved = await this.connection.send<{ object?: { objectId?: string } }>(
            'DOM.resolveNode', { backendNodeId: hit.backendNodeId }, this.sessionId,
          );
          hitObjectId = hitResolved.object?.objectId;
          if (!hitObjectId) return notDispatched('target_occluded');
          const allowed = await this.connection.send<EvaluateResult>('Runtime.callFunctionOn', {
            objectId: hitObjectId,
            functionDeclaration: ALLOWED_HIT_TEST_FN,
            arguments: [{ objectId: targetObjectId }],
            returnByValue: true,
          }, this.sessionId);
          if (allowed.result?.value !== true) return notDispatched('target_occluded');
        } finally {
          if (hitObjectId) {
            await this.connection.send('Runtime.releaseObject', { objectId: hitObjectId }, this.sessionId).catch(() => undefined);
          }
        }
      }

      try {
        await this.connection.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
        }, this.sessionId);
      } catch {
        return outcomeUnknown('activation');
      }
      try {
        await this.connection.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
        }, this.sessionId);
      } catch {
        return outcomeUnknown('activation');
      }
      return {
        outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true,
        retrySafe: false, delta: { kind: 'activation', changed: false },
      };
    } catch {
      return notDispatched('target_unavailable');
    } finally {
      if (targetObjectId) {
        await this.connection.send('Runtime.releaseObject', { objectId: targetObjectId }, this.sessionId).catch(() => undefined);
      }
    }
  }

  async fillBackendNode(backendNodeId: number, text: string): Promise<BrowserOperationReceipt> {
    if (text.length > 1_000_000) return notDispatched('unsupported_target');
    let objectId: string | undefined;
    try {
      const resolved = await this.connection.send<{ object?: { objectId?: string } }>(
        'DOM.resolveNode', { backendNodeId }, this.sessionId,
      );
      objectId = resolved.object?.objectId;
      if (!objectId) return notDispatched('target_unavailable');
      await this.connection.send('DOM.focus', { backendNodeId }, this.sessionId);
      const prepared = await this.connection.send<EvaluateResult>('Runtime.callFunctionOn', {
        objectId, functionDeclaration: PREPARE_TEXT_REPLACEMENT_FN, returnByValue: true,
      }, this.sessionId);
      const preparation = prepared.result?.value as { kind?: string; editable?: boolean } | undefined;
      if (!preparation?.editable) return notDispatched('unsupported_target');

      try {
        await this.connection.send('Input.insertText', { text }, this.sessionId);
      } catch (insertError) {
        if (!unsupportedCommand(insertError)) return outcomeUnknown('field');
        try {
          await this.connection.send('Input.dispatchKeyEvent', {
            type: 'char', text, unmodifiedText: text,
          }, this.sessionId);
        } catch (keyError) {
          if (!unsupportedCommand(keyError)) return outcomeUnknown('field');
          if (preparation.kind !== 'input' && preparation.kind !== 'textarea') {
            return notDispatched('unsupported_input_command');
          }
          try {
            const fallback = await this.connection.send<EvaluateResult>('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: NATIVE_TEXT_FALLBACK_FN,
              arguments: [{ value: text }],
              returnByValue: true,
            }, this.sessionId);
            if ((fallback.result?.value as { ok?: boolean } | undefined)?.ok !== true) {
              return notDispatched('unsupported_input_command');
            }
          } catch {
            return outcomeUnknown('field');
          }
        }
      }

      let verification: { matches?: boolean; normalizedLength?: number } | undefined;
      try {
        const result = await this.connection.send<EvaluateResult>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: VERIFY_TEXT_REPLACEMENT_FN,
          arguments: [{ value: text }],
          returnByValue: true,
        }, this.sessionId);
        verification = result.result?.value as { matches?: boolean; normalizedLength?: number } | undefined;
      } catch {
        return outcomeUnknown('field');
      }
      const normalizedLength = Number.isFinite(verification?.normalizedLength)
        ? Math.max(0, Math.min(1_000_000, Math.floor(verification!.normalizedLength!)))
        : undefined;
      if (verification?.matches !== true) {
        return {
          outcome: 'outcome_unknown', dispatchState: 'dispatched', verified: false,
          retrySafe: false, matchesRequested: false, ...(normalizedLength !== undefined ? { normalizedLength } : {}),
          reason: 'verification_mismatch', delta: { kind: 'field', changed: true },
        };
      }
      return {
        outcome: 'dispatched_verified', dispatchState: 'dispatched', verified: true,
        retrySafe: false, matchesRequested: true, ...(normalizedLength !== undefined ? { normalizedLength } : {}),
        delta: { kind: 'field', changed: true },
      };
    } catch {
      return notDispatched('target_unavailable');
    } finally {
      if (objectId) {
        await this.connection.send('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => undefined);
      }
    }
  }

  async inspectBackendNode(
    backendNodeId: number,
    functionDeclaration: string,
  ): Promise<InspectedElement | null> {
    return this.callBackendNode<InspectedElement>(backendNodeId, functionDeclaration);
  }

  async callBackendNode<T>(backendNodeId: number, functionDeclaration: string): Promise<T | null> {
    const { object } = await this.connection.send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId },
      this.sessionId,
    );
    if (!object.objectId) return null;
    try {
      const result = await this.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration, returnByValue: true },
        this.sessionId,
      );
      if (result.exceptionDetails) return null;
      return (result.result?.value ?? null) as T | null;
    } finally {
      await this.connection.send('Runtime.releaseObject', { objectId: object.objectId }, this.sessionId).catch(() => undefined);
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

  async getCookiesForUrls(urls: string[]): Promise<Array<Record<string, unknown>>> {
    await this.connection.send('Network.enable', {}, this.sessionId).catch(() => undefined);
    const result = await this.connection.send<{ cookies?: Array<Record<string, unknown>> }>(
      'Network.getCookies',
      { urls },
      this.sessionId,
    );
    return result.cookies ?? [];
  }

  async evaluateOnNewDocument(expression: string): Promise<void> {
    await this.connection.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: expression },
      this.sessionId,
    );
  }

  /**
   * KTD-12 fingerprint application (native path): UA override + init script,
   * target-scoped — both survive later CDP re-attaches (verified on Chromium
   * 151), and the init script's per-document guard makes re-application a
   * no-op.
   */
  async applyFingerprint(fingerprint: DesktopFingerprint): Promise<void> {
    await this.connection.send(
      'Emulation.setUserAgentOverride',
      userAgentOverrideParams(fingerprint),
      this.sessionId,
    );
    await this.connection.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildFingerprintInitScript(fingerprint) },
      this.sessionId,
    );
  }

  createNetworkCaptureTransport(): BrowserNetworkCaptureTransport {
    return new CdpNetworkCaptureTransport(this.connection, this.sessionId);
  }
}

const NETWORK_ENABLE_OPTIONS = {
  maxTotalBufferSize: 5 * 1024 * 1024,
  maxResourceBufferSize: 1024 * 1024,
  maxPostDataSize: 64 * 1024,
};

// Chromium freezes dedicated workers when Network.enable is sent to their
// flattened child session. Keep the page usable and retain worker target
// lifecycle events; worker-originated HTTP remains an explicit v1 limitation.
const NETWORK_TARGET_TYPES = new Set(['iframe']);

/**
 * Passive capture adapter. Related targets are attached without pausing page
 * execution, then receive Network listeners recursively. The pinned browser
 * does not answer Network.enable reliably for a paused worker, so worker
 * traffic that starts before child setup completes remains best-effort.
 */
export class CdpNetworkCaptureTransport implements BrowserNetworkCaptureTransport {
  private started = false;
  private readonly configuredSessions = new Set<string>();
  private readonly setupTasks = new Set<Promise<void>>();
  private offTargetAttached?: () => void;
  private offTargetDetached?: () => void;
  private generation = 0;

  constructor(
    private readonly connection: CdpConnection,
    readonly primarySessionId: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    this.offTargetAttached = this.connection.on('Target.attachedToTarget', (event) => {
      const params = event.params as {
        sessionId?: string;
        targetInfo?: { type?: string };
      };
      if (!params.sessionId) return;
      // Child setup is best-effort and the target is always resumed in
      // setupAttachedSession's finally block. Consume rejection here so a
      // detached/racing child never becomes an unhandled process rejection.
      const task = this.setupAttachedSession(
        params.sessionId,
        params.targetInfo?.type,
        generation,
      ).catch(() => undefined);
      this.setupTasks.add(task);
      void task.finally(() => this.setupTasks.delete(task));
    });
    this.offTargetDetached = this.connection.on('Target.detachedFromTarget', (event) => {
      const sessionId = (event.params as { sessionId?: string }).sessionId;
      if (sessionId) this.configuredSessions.delete(sessionId);
    });
    try {
      await this.setupSession(this.primarySessionId, generation);
      await this.drainSetupTasks();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return this.connection.send<T>(method, params, sessionId);
  }

  onEvent(listener: (event: CdpEventEnvelope) => void): () => void {
    return this.connection.onEvent(listener);
  }

  onClose(listener: () => void): () => void {
    return this.connection.onClose(listener);
  }

  stop(): void {
    this.offTargetAttached?.();
    this.offTargetDetached?.();
    this.offTargetAttached = undefined;
    this.offTargetDetached = undefined;
    this.configuredSessions.clear();
    this.setupTasks.clear();
    this.started = false;
    this.generation += 1;
  }

  private async setupAttachedSession(
    sessionId: string,
    targetType: string | undefined,
    generation: number,
  ): Promise<void> {
    if (generation === this.generation && targetType && NETWORK_TARGET_TYPES.has(targetType)) {
      await this.setupSession(sessionId, generation);
    }
  }

  private async setupSession(sessionId: string, generation: number): Promise<void> {
    if (this.configuredSessions.has(sessionId)) return;
    this.configuredSessions.add(sessionId);
    try {
      await this.connection.send('Network.enable', NETWORK_ENABLE_OPTIONS, sessionId);
      if (generation !== this.generation) {
        this.configuredSessions.delete(sessionId);
        return;
      }
      await this.connection.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, sessionId);
    } catch (error) {
      this.configuredSessions.delete(sessionId);
      throw error;
    }
  }

  private async drainSetupTasks(): Promise<void> {
    while (this.setupTasks.size > 0) {
      await Promise.all([...this.setupTasks]);
    }
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
 * Retry a CDP connect+attach across the cold-start window: a freshly spawned
 * view/target races Chromium's CDP readiness (the WS handshake hangs up, and
 * Target.getTargets finds no page yet — measured at ~1–2s on a cold start),
 * so the first connectSinglePage after a fresh spawn can fail transiently
 * with "CDP websocket connect failed: socket hang up". Without this,
 * browser-mcp's first navigate fails and the pane stays on about:blank.
 * Bounded retry lets the first tool call wait for Chromium instead.
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
 * Connect to a CDP endpoint that hosts exactly one page and attach to it
 * (the root WS path of the baseUrl). Fallback for baseUrls that do not carry
 * the __comate-cdp__ target convention.
 */
export async function connectSinglePage(
  baseUrl: string,
  options: CdpConnectionOptions = {},
): Promise<BrowserCdpSession> {
  const wsUrl = `${baseUrl.replace(/^http/i, 'ws')}/`;
  const budgetMs = options.connectReadyTimeoutMs ?? DEFAULT_CONNECT_READY_TIMEOUT_MS;
  const intervalMs = options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS;
  return retryDuringColdStart(
    async () => {
      const connection = await CdpConnection.connect(wsUrl, options);
      try {
        return await BrowserCdpSessionImpl.attach(connection);
      } catch (err) {
        connection.close();
        throw err;
      }
    },
    { budgetMs, intervalMs },
  );
}

// ---------------------------------------------------------------------------
// Native shell path (U7, KTD-6/KTD-12): attach to one page target of a
// debug-port Chromium (the in-shell Electron views, or an external fallback
// endpoint per R8/AE2). The shell binds the port to 127.0.0.1 and never sets
// --remote-allow-origins; this client works because the `ws` transport sends
// no Origin header (verified against Chromium 151).
// ---------------------------------------------------------------------------

/**
 * baseUrl convention carrying a native-target address through the existing
 * `connectPage(baseUrl)` tool-layer contract:
 *   http://<host>:<port>/__comate-cdp__/t/<targetId>   — attach by exact target
 *   http://<host>:<port>/__comate-cdp__/m/<marker>     — pick the page target
 *     whose URL contains <marker> (the pre-navigation about:blank#… marker the
 *     shell loads a fresh view with; only valid until the first navigation)
 */
export const CDP_PAGE_BASE_PATH = '/__comate-cdp__';

export interface CdpPageBaseAddress {
  host: string;
  port: number;
  targetId?: string;
  urlMarker?: string;
}

export function buildCdpPageBaseUrl(address: CdpPageBaseAddress): string {
  const selector = address.targetId
    ? `t/${encodeURIComponent(address.targetId)}`
    : `m/${encodeURIComponent(address.urlMarker ?? '')}`;
  return `http://${address.host}:${address.port}${CDP_PAGE_BASE_PATH}/${selector}`;
}

/** Parse the __comate-cdp__ baseUrl convention; null for anything else. */
export function parseCdpPageBaseUrl(baseUrl: string): CdpPageBaseAddress | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(`${CDP_PAGE_BASE_PATH}/`)) return null;
  const rest = url.pathname.slice(CDP_PAGE_BASE_PATH.length + 1);
  const [mode, ...tail] = rest.split('/');
  const value = decodeURIComponent(tail.join('/'));
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || !value) return null;
  if (mode === 't') return { host: url.hostname, port, targetId: value };
  if (mode === 'm') return { host: url.hostname, port, urlMarker: value };
  return null;
}

interface JsonVersionInfo {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  'User-Agent'?: string;
}

interface JsonTargetInfo {
  id: string;
  type: string;
  url: string;
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) {
    throw new CdpError(`CDP HTTP probe failed: ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

/** GET /json/version → browser-level WS URL (and product string). */
export async function fetchCdpBrowserInfo(
  address: { host?: string; port: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ browserWsUrl: string; product?: string }> {
  const host = address.host ?? '127.0.0.1';
  const info = await fetchJson<JsonVersionInfo>(
    `http://${host}:${address.port}/json/version`,
    fetchImpl,
  );
  if (!info.webSocketDebuggerUrl) {
    throw new CdpError('CDP /json/version did not report a browser websocket URL');
  }
  return { browserWsUrl: info.webSocketDebuggerUrl, product: info.Browser };
}

/** GET /json/list — the debug port's target table. */
export async function listCdpTargets(
  address: { host?: string; port: number },
  fetchImpl: typeof fetch = fetch,
): Promise<JsonTargetInfo[]> {
  const host = address.host ?? '127.0.0.1';
  return fetchJson<JsonTargetInfo[]>(`http://${host}:${address.port}/json/list`, fetchImpl);
}

/**
 * Resolve the targetId of the page target whose URL carries the marker (the
 * shell loads a fresh view with `about:blank#<marker>`; verified to survive
 * in /json/list on Chromium 151 and Electron 43). Used once per view, right
 * after control-channel creation — afterwards the registry pins the targetId
 * (the marker URL is replaced by the first real navigation).
 */
export async function findCdpTargetIdByMarker(
  address: { host?: string; port: number },
  urlMarker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const targets = await listCdpTargets(address, fetchImpl);
  return targets.find((target) => target.type === 'page' && target.url.includes(urlMarker))?.id;
}

export interface ShellPageConnectOptions extends CdpConnectionOptions {
  /** Debug port (loopback). */
  port: number;
  host?: string;
  /** Injectable browser-level WS URL (tests point at a fake). */
  browserWsUrl?: string;
  /** Exact target (post-spawn reconnects, external fallback). */
  targetId?: string;
  /** Marker lookup (only before the first navigation). */
  urlMarker?: string;
  /**
   * Apply the KTD-12 desktop-Chrome fingerprint (UA override + init script).
   * Default true — every session page presents as a synthetic desktop Chrome.
   */
  fingerprint?: boolean;
  /** Host OS/arch for the fingerprint; default process.platform/arch. */
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Connect to a debug-port Chromium and attach (flatten) to one session's
 * page target, then apply the desktop-Chrome fingerprint (KTD-12). The whole
 * connect+attach retries across the cold-start window (10s/300ms budget —
 * the shell's view may still be loading its marker page when the sidecar
 * first dials).
 */
export async function connectShellPage(
  options: ShellPageConnectOptions,
): Promise<BrowserCdpSession> {
  const budgetMs = options.connectReadyTimeoutMs ?? DEFAULT_CONNECT_READY_TIMEOUT_MS;
  const intervalMs = options.connectRetryIntervalMs ?? DEFAULT_CONNECT_RETRY_INTERVAL_MS;
  return retryDuringColdStart(
    async () => {
      const browserWsUrl = await resolveBrowserWsUrl(options);
      const connection = await CdpConnection.connect(browserWsUrl, options);
      try {
        const targetId = await resolveShellTargetId(connection, options);
        const session = await BrowserCdpSessionImpl.attachTo(connection, targetId);
        if (options.fingerprint !== false) {
          await applyShellFingerprint(connection, session, options);
        }
        return session;
      } catch (err) {
        connection.close();
        throw err;
      }
    },
    { budgetMs, intervalMs },
  );
}

async function resolveBrowserWsUrl(options: ShellPageConnectOptions): Promise<string> {
  if (options.browserWsUrl) return options.browserWsUrl;
  const info = await fetchCdpBrowserInfo(
    { host: options.host, port: options.port },
    options.fetchImpl,
  );
  return info.browserWsUrl;
}

async function resolveShellTargetId(
  connection: CdpConnection,
  options: ShellPageConnectOptions,
): Promise<string> {
  if (options.targetId) return options.targetId;
  if (options.urlMarker) {
    const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>(
      'Target.getTargets',
    );
    const page = targetInfos.find(
      (target) => target.type === 'page' && target.url?.includes(options.urlMarker ?? ''),
    );
    if (!page) {
      throw new CdpError(
        `No page target carrying the session view marker on debug port ${options.port}`,
        'Target.getTargets',
      );
    }
    return page.targetId;
  }
  throw new CdpError('connectShellPage requires targetId or urlMarker', 'Target.getTargets');
}

async function applyShellFingerprint(
  connection: CdpConnection,
  session: BrowserCdpSessionImpl,
  options: ShellPageConnectOptions,
): Promise<void> {
  // Engine version from the browser itself so UA / UA-CH / engine never
  // disagree (KTD-12). Falls back to the UA when product parsing fails.
  let chromeVersion: string | undefined;
  try {
    const version = await connection.send<{ product?: string; userAgent?: string }>(
      'Browser.getVersion',
    );
    chromeVersion =
      (version.product ? parseChromeVersion(version.product) : undefined) ??
      (version.userAgent ? parseChromeVersion(version.userAgent) : undefined);
  } catch {
    chromeVersion = undefined;
  }
  if (!chromeVersion) {
    throw new CdpError('Could not determine the attached Chromium version for fingerprinting');
  }
  const fingerprint: DesktopFingerprint = buildDesktopFingerprint({
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    chromeVersion,
  });
  await session.applyFingerprint(fingerprint);
}

/** Create a fresh page target on any debug-port Chromium (R8 external fallback). */
export async function createShellTarget(
  options: { port: number; host?: string; url?: string; isolate?: boolean; fetchImpl?: typeof fetch },
): Promise<{ targetId: string; browserContextId?: string }> {
  const browserWsUrl = await resolveBrowserWsUrl({ port: options.port, host: options.host, fetchImpl: options.fetchImpl });
  const connection = await CdpConnection.connect(browserWsUrl, {});
  try {
    let browserContextId: string | undefined;
    if (options.isolate) {
      // A throwaway per-session browser context gives the external fallback
      // the same cookie/storage isolation the shell's partitions do (KTD-10
      // semantics, CDP mechanics).
      const context = await connection.send<{ browserContextId: string }>('Target.createBrowserContext', {
        disposeOnDetach: false,
      });
      browserContextId = context.browserContextId;
    }
    try {
      const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', {
        url: options.url ?? 'about:blank',
        ...(browserContextId ? { browserContextId } : {}),
      });
      return browserContextId ? { targetId, browserContextId } : { targetId };
    } catch (err) {
      if (browserContextId) {
        await connection
          .send('Target.disposeBrowserContext', { browserContextId })
          .catch(() => undefined);
      }
      throw err;
    }
  } finally {
    connection.close();
  }
}

/** Close a page target (external-fallback teardown); disposes its isolated context when present. */
export async function closeShellTarget(
  options: { port: number; host?: string; targetId: string; browserContextId?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const browserWsUrl = await resolveBrowserWsUrl(options);
  const connection = await CdpConnection.connect(browserWsUrl, {});
  try {
    await connection.send('Target.closeTarget', { targetId: options.targetId });
    if (options.browserContextId) {
      await connection
        .send('Target.disposeBrowserContext', { browserContextId: options.browserContextId })
        .catch(() => undefined);
    }
  } finally {
    connection.close();
  }
}

/**
 * Unified page connector (U7): routes the __comate-cdp__ baseUrl convention
 * to the native path and everything else to the single-page fallback. This
 * is the default `connectPage` for the tool layer and the service's internal
 * CDP reads, so switching a session's CDP target never requires a tool-layer
 * change (AE2).
 */
export async function connectBrowserPage(
  baseUrl: string,
  options: CdpConnectionOptions = {},
): Promise<BrowserCdpSession> {
  const address = parseCdpPageBaseUrl(baseUrl);
  if (!address) {
    return connectSinglePage(baseUrl, options);
  }
  return connectShellPage({
    ...options,
    port: address.port,
    host: address.host,
    ...(address.targetId ? { targetId: address.targetId } : {}),
    ...(address.urlMarker ? { urlMarker: address.urlMarker } : {}),
  });
}

/**
 * Session-context export (remember-site / authenticated-request, AE3):
 * cookies via Network.getCookies for the open page's URLs + web storage
 * dumped in-page, keyed by page hostname. IndexedDB is out of scope (R15).
 * Read-only; safe during user_in_control.
 */
export async function exportCdpSessionContext(baseUrl: string): Promise<unknown> {
  const page = await connectBrowserPage(baseUrl, { commandTimeoutMs: 10_000 });
  try {
    const href = await page.evaluate<string>('(() => window.location.href)()');
    if (typeof href !== 'string' || !/^https?:\/\//.test(href)) {
      return { cookies: [], localStorage: {}, sessionStorage: {} };
    }
    const hostname = new URL(href).hostname;
    const origin = new URL(href).origin;
    const storage = await page.evaluate<{
      local: Record<string, string>;
      session: Record<string, string>;
    }>(`(() => {
      var dump = function (store) {
        var out = {};
        try {
          for (var i = 0; i < store.length; i++) {
            var k = store.key(i);
            out[k] = store.getItem(k);
          }
        } catch (e) {}
        return out;
      };
      return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
    })()`);
    const cookies = page.getCookiesForUrls ? await page.getCookiesForUrls([href, origin]) : [];
    return {
      cookies,
      localStorage: { [hostname]: storage.local },
      sessionStorage: { [hostname]: storage.session },
    };
  } finally {
    page.close();
  }
}
