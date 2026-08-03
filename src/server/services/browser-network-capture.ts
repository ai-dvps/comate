import { randomUUID } from 'node:crypto';

export interface CdpEventEnvelope {
  method: string;
  params: unknown;
  sessionId?: string;
}

/** Minimal injectable surface used by the capture assembler and its fakes. */
export interface BrowserNetworkCaptureTransport {
  readonly primarySessionId: string;
  start(): Promise<void>;
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  onEvent(listener: (event: CdpEventEnvelope) => void): () => void;
  onClose(listener: () => void): () => void;
}

export type CaptureIncompleteReason =
  | 'body_unavailable'
  | 'loading_failed'
  | 'target_detached'
  | 'deadline_exceeded'
  | 'connection_closed';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, unknown>;
  postData?: string;
  hasPostData?: boolean;
}

export interface CapturedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, unknown>;
  mimeType?: string;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
}

export interface CapturedResponseBody {
  body: string;
  base64Encoded: boolean;
}

export interface CapturedNetworkHop {
  index: number;
  request: CapturedRequest;
  requestExtraHeaders?: Record<string, unknown>;
  response?: CapturedResponse;
  responseExtraHeaders?: Record<string, unknown>;
  responseBody?: CapturedResponseBody;
  resourceType?: string;
  initiator?: unknown;
  incompleteReasons: CaptureIncompleteReason[];
  terminal: boolean;
  failure?: { errorText?: string; blockedReason?: string; canceled?: boolean };
  /** True when responseReceivedExtraInfo supplied the authoritative status. */
  authoritativeStatus: boolean;
}

export interface CapturedNetworkChain {
  sessionId: string;
  requestId: string;
  hops: CapturedNetworkHop[];
  incompleteReasons: CaptureIncompleteReason[];
}

export interface BrowserNetworkCaptureResult {
  captureId: string;
  state: 'complete' | 'aborted';
  startedAt: number;
  stoppedAt: number;
  chains: CapturedNetworkChain[];
  incompleteReasons: CaptureIncompleteReason[];
}

export interface BrowserNetworkCaptureOptions {
  quietMs?: number;
  hardDeadlineMs?: number;
  now?: () => number;
}

export class BrowserNetworkCaptureError extends Error {
  constructor(
    readonly code: 'capture_already_active' | 'capture_not_active',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserNetworkCaptureError';
  }
}

interface RequestEvent {
  requestId?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    postData?: string;
    hasPostData?: boolean;
  };
  type?: string;
  initiator?: unknown;
  redirectResponse?: ResponseEvent['response'];
}

interface ResponseEvent {
  requestId?: string;
  response?: {
    url?: string;
    status?: number;
    statusText?: string;
    headers?: Record<string, unknown>;
    mimeType?: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
  };
}

interface ExtraInfoEvent {
  requestId?: string;
  headers?: Record<string, unknown>;
  statusCode?: number;
}

interface CaptureContext {
  captureId: string;
  state: 'recording' | 'draining' | 'aborted';
  admissionOpen: boolean;
  startedAt: number;
  chains: Map<string, CapturedNetworkChain>;
  chainOrder: CapturedNetworkChain[];
  pendingRequestExtras: Map<string, ExtraInfoEvent[]>;
  pendingResponseExtras: Map<string, ExtraInfoEvent[]>;
  pendingBodies: Set<Promise<void>>;
  incompleteReasons: Set<CaptureIncompleteReason>;
  offEvent: () => void;
  offClose: () => void;
  quietTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  resolveResult: (result: BrowserNetworkCaptureResult) => void;
  resultPromise: Promise<BrowserNetworkCaptureResult>;
  settled: boolean;
}

const DEFAULT_QUIET_MS = 250;
const DEFAULT_HARD_DEADLINE_MS = 10_000;

function identity(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function addReason(
  chain: CapturedNetworkChain,
  hop: CapturedNetworkHop,
  reason: CaptureIncompleteReason,
): void {
  if (!hop.incompleteReasons.includes(reason)) hop.incompleteReasons.push(reason);
  if (!chain.incompleteReasons.includes(reason)) chain.incompleteReasons.push(reason);
}

function responseFrom(raw: NonNullable<ResponseEvent['response']>): CapturedResponse {
  return {
    url: raw.url ?? '',
    status: raw.status ?? 0,
    statusText: raw.statusText ?? '',
    headers: raw.headers ?? {},
    ...(raw.mimeType ? { mimeType: raw.mimeType } : {}),
    ...(raw.fromDiskCache !== undefined ? { fromDiskCache: raw.fromDiskCache } : {}),
    ...(raw.fromServiceWorker !== undefined ? { fromServiceWorker: raw.fromServiceWorker } : {}),
  };
}

function currentHop(chain: CapturedNetworkChain): CapturedNetworkHop {
  return chain.hops[chain.hops.length - 1];
}

export class BrowserNetworkCaptureManager {
  private readonly quietMs: number;
  private readonly hardDeadlineMs: number;
  private readonly now: () => number;
  private readonly bodyReads = new WeakSet<CapturedNetworkHop>();
  private current?: CaptureContext;

  constructor(
    private readonly transport: BrowserNetworkCaptureTransport,
    options: BrowserNetworkCaptureOptions = {},
  ) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.hardDeadlineMs = options.hardDeadlineMs ?? DEFAULT_HARD_DEADLINE_MS;
    this.now = options.now ?? Date.now;
  }

  get state(): 'idle' | 'recording' | 'draining' {
    if (!this.current) return 'idle';
    return this.current.state === 'recording' ? 'recording' : 'draining';
  }

  async start(): Promise<{ captureId: string; state: 'recording' }> {
    if (this.current) {
      throw new BrowserNetworkCaptureError('capture_already_active', 'A network capture is already active');
    }
    let resolveResult!: (result: BrowserNetworkCaptureResult) => void;
    const resultPromise = new Promise<BrowserNetworkCaptureResult>((resolve) => {
      resolveResult = resolve;
    });
    const context: CaptureContext = {
      captureId: `cap_${randomUUID().replace(/-/g, '')}`,
      state: 'recording',
      admissionOpen: true,
      startedAt: this.now(),
      chains: new Map(),
      chainOrder: [],
      pendingRequestExtras: new Map(),
      pendingResponseExtras: new Map(),
      pendingBodies: new Set(),
      incompleteReasons: new Set(),
      offEvent: () => {},
      offClose: () => {},
      resolveResult,
      resultPromise,
      settled: false,
    };
    this.current = context;
    context.offEvent = this.transport.onEvent((event) => this.handleEvent(context, event));
    context.offClose = this.transport.onClose(() => this.abortContext(context, 'connection_closed'));
    try {
      await this.transport.start();
    } catch (error) {
      context.offEvent();
      context.offClose();
      this.current = undefined;
      throw error;
    }
    return { captureId: context.captureId, state: 'recording' };
  }

  stop(): Promise<BrowserNetworkCaptureResult> {
    const context = this.current;
    if (!context) {
      return Promise.reject(new BrowserNetworkCaptureError('capture_not_active', 'No network capture is active'));
    }
    if (context.state === 'recording') {
      context.state = 'draining';
      context.admissionOpen = false;
      context.deadlineTimer = setTimeout(() => this.finishAtDeadline(context), this.hardDeadlineMs);
      context.deadlineTimer.unref?.();
      this.maybeScheduleCompletion(context);
    }
    return context.resultPromise;
  }

  abort(reason: CaptureIncompleteReason = 'connection_closed'): void {
    if (this.current) this.abortContext(this.current, reason);
  }

  private handleEvent(context: CaptureContext, event: CdpEventEnvelope): void {
    if (this.current !== context || context.settled) return;
    const params = (event.params ?? {}) as Record<string, unknown>;
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    const sessionId = event.sessionId ?? this.transport.primarySessionId;
    const key = requestId ? identity(sessionId, requestId) : undefined;

    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.onRequest(context, sessionId, params as RequestEvent);
        break;
      case 'Network.requestWillBeSentExtraInfo':
        if (key) this.onRequestExtra(context, key, params as ExtraInfoEvent);
        break;
      case 'Network.responseReceived':
        if (key) this.onResponse(context, key, params as ResponseEvent);
        break;
      case 'Network.responseReceivedExtraInfo':
        if (key) this.onResponseExtra(context, key, params as ExtraInfoEvent);
        break;
      case 'Network.loadingFinished':
        if (key && requestId) this.onLoadingFinished(context, key, sessionId, requestId);
        break;
      case 'Network.loadingFailed':
        if (key) this.onLoadingFailed(context, key, params);
        break;
      case 'Target.detachedFromTarget': {
        const detached = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        if (detached) this.onTargetDetached(context, detached);
        break;
      }
    }
  }

  private onRequest(context: CaptureContext, sessionId: string, event: RequestEvent): void {
    if (!event.requestId || !event.request?.url || !event.request.method) return;
    const key = identity(sessionId, event.requestId);
    let chain = context.chains.get(key);
    if (!chain) {
      if (!context.admissionOpen) return;
      chain = { sessionId, requestId: event.requestId, hops: [], incompleteReasons: [] };
      context.chains.set(key, chain);
      context.chainOrder.push(chain);
    } else if (event.redirectResponse && chain.hops.length > 0) {
      const previous = currentHop(chain);
      if (!previous.response) previous.response = responseFrom(event.redirectResponse);
      else if (!previous.authoritativeStatus) previous.response.status = event.redirectResponse.status ?? previous.response.status;
      previous.terminal = true;
    }

    const hop: CapturedNetworkHop = {
      index: chain.hops.length,
      request: {
        url: event.request.url,
        method: event.request.method,
        headers: event.request.headers ?? {},
        ...(event.request.postData !== undefined ? { postData: event.request.postData } : {}),
        ...(event.request.hasPostData !== undefined ? { hasPostData: event.request.hasPostData } : {}),
      },
      ...(event.type ? { resourceType: event.type } : {}),
      ...(event.initiator !== undefined ? { initiator: event.initiator } : {}),
      incompleteReasons: [],
      terminal: false,
      authoritativeStatus: false,
    };
    chain.hops.push(hop);
    const requestExtras = context.pendingRequestExtras.get(key);
    if (requestExtras?.length) {
      const extra = requestExtras.shift();
      if (extra?.headers) hop.requestExtraHeaders = extra.headers;
      if (requestExtras.length === 0) context.pendingRequestExtras.delete(key);
    }
    const responseExtras = context.pendingResponseExtras.get(key);
    if (responseExtras?.length) {
      const extra = responseExtras.shift();
      if (extra) this.applyResponseExtra(hop, extra);
      if (responseExtras.length === 0) context.pendingResponseExtras.delete(key);
    }
    this.noteActivity(context);
  }

  private onRequestExtra(context: CaptureContext, key: string, event: ExtraInfoEvent): void {
    const chain = context.chains.get(key);
    const hop = chain?.hops.find((candidate) => candidate.requestExtraHeaders === undefined);
    if (hop) hop.requestExtraHeaders = event.headers ?? {};
    else {
      const pending = context.pendingRequestExtras.get(key) ?? [];
      pending.push(event);
      context.pendingRequestExtras.set(key, pending);
    }
    if (chain) this.noteActivity(context);
  }

  private onResponse(context: CaptureContext, key: string, event: ResponseEvent): void {
    const chain = context.chains.get(key);
    if (!chain || !event.response) return;
    const hop = currentHop(chain);
    const authoritativeStatus = hop.authoritativeStatus ? hop.response?.status : undefined;
    hop.response = responseFrom(event.response);
    if (authoritativeStatus !== undefined) hop.response.status = authoritativeStatus;
    this.noteActivity(context);
  }

  private onResponseExtra(context: CaptureContext, key: string, event: ExtraInfoEvent): void {
    const chain = context.chains.get(key);
    const hop = chain?.hops.find((candidate) => !candidate.authoritativeStatus);
    if (hop) this.applyResponseExtra(hop, event);
    else {
      const pending = context.pendingResponseExtras.get(key) ?? [];
      pending.push(event);
      context.pendingResponseExtras.set(key, pending);
    }
    if (chain) this.noteActivity(context);
  }

  private applyResponseExtra(hop: CapturedNetworkHop, event: ExtraInfoEvent): void {
    if (event.headers) hop.responseExtraHeaders = event.headers;
    if (typeof event.statusCode === 'number') {
      if (!hop.response) {
        hop.response = { url: hop.request.url, status: event.statusCode, statusText: '', headers: {} };
      } else {
        hop.response.status = event.statusCode;
      }
      hop.authoritativeStatus = true;
    }
  }

  private onLoadingFinished(
    context: CaptureContext,
    key: string,
    sessionId: string,
    requestId: string,
  ): void {
    const chain = context.chains.get(key);
    if (!chain) return;
    const hop = currentHop(chain);
    if (this.bodyReads.has(hop)) return;
    this.bodyReads.add(hop);
    hop.terminal = true;
    const bodyTask = this.transport
      .send<CapturedResponseBody>('Network.getResponseBody', { requestId }, sessionId)
      .then((body) => {
        if (!context.settled) hop.responseBody = body;
      })
      .catch(() => {
        if (!context.settled) addReason(chain, hop, 'body_unavailable');
      })
      .finally(() => {
        context.pendingBodies.delete(bodyTask);
        this.noteActivity(context);
      });
    context.pendingBodies.add(bodyTask);
    this.noteActivity(context);
  }

  private onLoadingFailed(context: CaptureContext, key: string, params: Record<string, unknown>): void {
    const chain = context.chains.get(key);
    if (!chain) return;
    const hop = currentHop(chain);
    hop.terminal = true;
    hop.failure = {
      ...(typeof params.errorText === 'string' ? { errorText: params.errorText } : {}),
      ...(typeof params.blockedReason === 'string' ? { blockedReason: params.blockedReason } : {}),
      ...(typeof params.canceled === 'boolean' ? { canceled: params.canceled } : {}),
    };
    addReason(chain, hop, 'loading_failed');
    this.noteActivity(context);
  }

  private onTargetDetached(context: CaptureContext, sessionId: string): void {
    let touched = false;
    for (const chain of context.chainOrder) {
      if (chain.sessionId !== sessionId) continue;
      const hop = currentHop(chain);
      if (hop.terminal) continue;
      hop.terminal = true;
      addReason(chain, hop, 'target_detached');
      touched = true;
    }
    if (touched) this.noteActivity(context);
  }

  private noteActivity(context: CaptureContext): void {
    if (context.state !== 'draining' || context.settled) return;
    if (context.quietTimer) clearTimeout(context.quietTimer);
    context.quietTimer = undefined;
    this.maybeScheduleCompletion(context);
  }

  private maybeScheduleCompletion(context: CaptureContext): void {
    if (context.state !== 'draining' || context.settled) return;
    const active = context.chainOrder.some((chain) => !currentHop(chain).terminal);
    if (active || context.pendingBodies.size > 0 || context.quietTimer) return;
    context.quietTimer = setTimeout(() => this.settle(context, 'complete'), this.quietMs);
    context.quietTimer.unref?.();
  }

  private finishAtDeadline(context: CaptureContext): void {
    if (context.settled) return;
    for (const chain of context.chainOrder) {
      const hop = currentHop(chain);
      if (hop.terminal) continue;
      hop.terminal = true;
      addReason(chain, hop, 'deadline_exceeded');
    }
    if (context.pendingBodies.size > 0) context.incompleteReasons.add('deadline_exceeded');
    this.settle(context, 'complete');
  }

  private abortContext(context: CaptureContext, reason: CaptureIncompleteReason): void {
    if (context.settled) return;
    context.state = 'aborted';
    context.admissionOpen = false;
    context.incompleteReasons.add(reason);
    for (const chain of context.chainOrder) {
      const hop = currentHop(chain);
      if (!hop.terminal) {
        hop.terminal = true;
        addReason(chain, hop, reason);
      }
    }
    this.settle(context, 'aborted');
  }

  private settle(context: CaptureContext, state: 'complete' | 'aborted'): void {
    if (context.settled) return;
    context.settled = true;
    if (context.quietTimer) clearTimeout(context.quietTimer);
    if (context.deadlineTimer) clearTimeout(context.deadlineTimer);
    context.offEvent();
    context.offClose();
    if (this.current === context) this.current = undefined;
    context.resolveResult({
      captureId: context.captureId,
      state,
      startedAt: context.startedAt,
      stoppedAt: this.now(),
      chains: context.chainOrder,
      incompleteReasons: [...context.incompleteReasons],
    });
  }
}
