import { createHmac, randomUUID } from 'node:crypto';
import type { BrowserOperationReceipt } from './browser-cdp.js';
import {
  store as defaultStore,
  type BrowserOperationEntry,
  type SqliteStore,
} from '../storage/sqlite-store.js';
import { getCredentialKey } from '../utils/credential-crypto.js';
import { BrowserAuditService } from './browser-audit.js';

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_VERSION = 'v1';

export interface BrowserInvocationScope {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runtimeGeneration: string;
  readonly capabilityId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly signal: AbortSignal;
  /** Request-fresh authority check, evaluated immediately before intent. */
  readonly isCurrent: () => boolean | Promise<boolean>;
}

export interface BrowserMutationRequest {
  action: 'open' | 'fill' | 'select' | 'check' | 'submit' | 'activation' | 'upload' | 'close' | 'control';
  /** Used only to compute the private replay-binding digest; never persisted. */
  privateParameters: unknown;
  requestApproval?: (requestId: string, signal: AbortSignal) => Promise<boolean>;
  revalidate?: () => boolean | Promise<boolean>;
  /** Handler calls authorizeDispatch at its exact physical side-effect boundary. */
  deferredDispatchIntent?: boolean;
  /** Handler owns a human approval round-trip and must persist allow before intent. */
  approvalRequired?: boolean;
  /** Persist trusted task validation state at the final dispatch boundary. */
  prepareDispatch?: () => boolean | Promise<boolean>;
  /** Compensate prepareDispatch only when durable dispatch intent could not be recorded. */
  rollbackPreparedDispatch?: () => void | Promise<void>;
  dispatch: (
    signal: AbortSignal,
    authorizeDispatch: () => Promise<boolean>,
    recordApproved: () => Promise<boolean>,
  ) => Promise<BrowserOperationReceipt>;
}

export class BrowserMutationConflictError extends Error {
  constructor() {
    super('Browser operation ID is already bound to a different principal or request');
    this.name = 'BrowserMutationConflictError';
  }
}

interface InflightOperation {
  principalId: string;
  digest: string;
  promise: Promise<BrowserOperationReceipt>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

export function browserMutationParameterDigest(action: string, parameters: unknown): string {
  return `${DIGEST_VERSION}:${createHmac('sha256', getCredentialKey())
    .update(`browser-operation-parameters:${DIGEST_VERSION}\0${action}\0${stableJson(parameters)}`).digest('hex')}`;
}

function notDispatched(reason: string): BrowserOperationReceipt {
  return {
    outcome: 'not_dispatched', dispatchState: 'not_dispatched', verified: false,
    retrySafe: true, reason: reason as BrowserOperationReceipt['reason'],
    delta: { kind: 'none', changed: false },
  };
}

function unknown(): BrowserOperationReceipt {
  return {
    outcome: 'outcome_unknown', dispatchState: 'dispatched', verified: false,
    retrySafe: false, reason: 'dispatch_failed', delta: { kind: 'none', changed: false },
  };
}

export class BrowserMutationCoordinator {
  private readonly store: SqliteStore;
  private readonly audit: Pick<BrowserAuditService, 'logMutation'>;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inflight = new Map<string, InflightOperation>();
  private readonly cancellers = new Map<string, Set<AbortController>>();
  private readonly cancellationReasons = new WeakMap<AbortController, string>();
  private readonly actionByController = new WeakMap<AbortController, BrowserMutationRequest['action']>();

  constructor(options: { store?: SqliteStore; recover?: boolean; audit?: Pick<BrowserAuditService, 'logMutation'> } = {}) {
    this.store = options.store ?? defaultStore;
    this.audit = options.audit ?? new BrowserAuditService(this.store);
    if (options.recover !== false) this.store.recoverBrowserOperations();
  }

  observe<T>(_sessionId: string, fn: () => T | Promise<T>): Promise<T> {
    return Promise.resolve().then(fn);
  }

  cancelSession(sessionId: string, reason = 'control_taken_over'): void {
    for (const controller of this.cancellers.get(sessionId) ?? []) {
      if (this.actionByController.get(controller) === 'control') continue;
      this.cancellationReasons.set(controller, reason);
      controller.abort();
    }
  }

  execute(scope: BrowserInvocationScope, request: BrowserMutationRequest): Promise<BrowserOperationReceipt> {
    if (!OPERATION_ID_RE.test(scope.operationId)) {
      return Promise.reject(new Error('operationId must be 1-128 bounded caller-stable characters'));
    }
    const digest = browserMutationParameterDigest(request.action, request.privateParameters);
    const operationKey = `${scope.principalId}\0${scope.operationId}`;
    const inflight = this.inflight.get(operationKey);
    if (inflight) {
      if (inflight.principalId !== scope.principalId || inflight.digest !== digest) {
        return Promise.reject(new BrowserMutationConflictError());
      }
      return inflight.promise;
    }

    const controller = new AbortController();
    this.actionByController.set(controller, request.action);
    const set = this.cancellers.get(scope.sessionId) ?? new Set<AbortController>();
    set.add(controller);
    this.cancellers.set(scope.sessionId, set);
    const abortFromCaller = () => {
      this.cancellationReasons.set(controller, 'cancelled');
      controller.abort();
    };
    if (scope.signal.aborted) abortFromCaller();
    else scope.signal.addEventListener('abort', abortFromCaller, { once: true });

    const promise = this.runSerialized(scope, request, digest, controller).finally(() => {
      scope.signal.removeEventListener('abort', abortFromCaller);
      set.delete(controller);
      if (set.size === 0) this.cancellers.delete(scope.sessionId);
      this.inflight.delete(operationKey);
    });
    this.inflight.set(operationKey, { principalId: scope.principalId, digest, promise });
    return promise;
  }

  private runSerialized(
    scope: BrowserInvocationScope,
    request: BrowserMutationRequest,
    digest: string,
    controller: AbortController,
  ): Promise<BrowserOperationReceipt> {
    const previous = this.tails.get(scope.sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(scope.sessionId, current);
    return previous.catch(() => {}).then(() => this.run(scope, request, digest, controller)).finally(() => {
      release();
      if (this.tails.get(scope.sessionId) === current) this.tails.delete(scope.sessionId);
    });
  }

  private async run(
    scope: BrowserInvocationScope,
    request: BrowserMutationRequest,
    digest: string,
    controller: AbortController,
  ): Promise<BrowserOperationReceipt> {
    const existing = this.store.getBrowserOperation(scope.principalId, scope.operationId);
    if (existing) return this.replay(existing, scope, request.action, digest);

    try {
      this.store.proposeBrowserOperation({
        operationId: scope.operationId,
        principalId: scope.principalId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        runtimeGeneration: scope.runtimeGeneration,
        capabilityId: scope.capabilityId,
        action: request.action,
        parameterDigest: digest,
      });
    } catch (error) {
      const raced = this.store.getBrowserOperation(scope.principalId, scope.operationId);
      if (raced) return this.replay(raced, scope, request.action, digest);
      throw error;
    }

    if (controller.signal.aborted) {
      return this.persistTerminal(scope, request.action, notDispatched(this.cancelReason(controller, 'cancelled')));
    }
    let approvalPersisted = false;
    if (request.requestApproval) {
      const approved = await request.requestApproval(randomUUID(), controller.signal);
      if (!approved || controller.signal.aborted) {
        return this.persistTerminal(scope, request.action, notDispatched(this.cancelReason(controller, 'user_denied')));
      }
      if (!this.store.markBrowserOperationApproved(scope.principalId, scope.operationId)) return unknown();
      approvalPersisted = true;
    }

    let intentPersisted = false;
    let dispatchPrepared = false;
    let authorizationFailure: BrowserOperationReceipt | undefined;
    const recordApproved = async (): Promise<boolean> => {
      if (approvalPersisted) return true;
      if (controller.signal.aborted) {
        authorizationFailure = notDispatched(this.cancelReason(controller, 'cancelled'));
        return false;
      }
      try {
        approvalPersisted = this.store.markBrowserOperationApproved(scope.principalId, scope.operationId);
      } catch {
        authorizationFailure = notDispatched('dispatch_failed');
        return false;
      }
      if (!approvalPersisted) authorizationFailure = notDispatched('dispatch_failed');
      return approvalPersisted;
    };
    const authorizeDispatch = async (): Promise<boolean> => {
      if (intentPersisted) return true;
      if (controller.signal.aborted) {
        authorizationFailure = notDispatched(this.cancelReason(controller, 'cancelled'));
        return false;
      }
      if (!await scope.isCurrent()) {
        authorizationFailure = notDispatched('runtime_replaced');
        return false;
      }
      if (request.revalidate && !await request.revalidate()) {
        authorizationFailure = notDispatched('target_changed');
        return false;
      }
      if (request.approvalRequired && !approvalPersisted) {
        authorizationFailure = notDispatched('dispatch_failed');
        return false;
      }
      try {
        dispatchPrepared = request.prepareDispatch ? await request.prepareDispatch() : true;
      } catch {
        dispatchPrepared = false;
      }
      if (!dispatchPrepared) {
        authorizationFailure = notDispatched('dispatch_failed');
        return false;
      }
      try {
        intentPersisted = this.store.markBrowserOperationDispatchIntent(scope.principalId, scope.operationId);
      } catch {
        await Promise.resolve(request.rollbackPreparedDispatch?.()).catch(() => undefined);
        authorizationFailure = notDispatched('dispatch_failed');
        return false;
      }
      if (!intentPersisted) {
        await Promise.resolve(request.rollbackPreparedDispatch?.()).catch(() => undefined);
        authorizationFailure = notDispatched('dispatch_failed');
      }
      return intentPersisted;
    };
    let receipt: BrowserOperationReceipt;
    try {
      if (!request.deferredDispatchIntent && !await authorizeDispatch()) {
        return this.persistTerminal(scope, request.action, authorizationFailure ?? notDispatched('dispatch_failed'));
      }
      receipt = await request.dispatch(controller.signal, authorizeDispatch, recordApproved);
    } catch {
      receipt = intentPersisted ? unknown() : notDispatched('dispatch_failed');
    }
    if (authorizationFailure) receipt = authorizationFailure;
    if (receipt.dispatchState === 'dispatched' && !intentPersisted) {
      receipt = notDispatched('dispatch_failed');
    }
    try {
      if (!this.store.completeBrowserOperation(scope.principalId, scope.operationId, receipt)) return unknown();
      this.logReceipt(scope, request.action, receipt);
      return receipt;
    } catch {
      const uncertain = unknown();
      this.logReceipt(scope, request.action, uncertain);
      return uncertain;
    }
  }

  private replay(
    existing: BrowserOperationEntry,
    scope: BrowserInvocationScope,
    action: string,
    digest: string,
  ): BrowserOperationReceipt {
    if (existing.principalId !== scope.principalId || existing.parameterDigest !== digest ||
        existing.action !== action || existing.sessionId !== scope.sessionId ||
        existing.workspaceId !== scope.workspaceId) {
      throw new BrowserMutationConflictError();
    }
    return existing.receipt ? existing.receipt as BrowserOperationReceipt : unknown();
  }

  private persistTerminal(
    scope: BrowserInvocationScope,
    action: BrowserMutationRequest['action'],
    receipt: BrowserOperationReceipt,
  ): BrowserOperationReceipt {
    try {
      if (!this.store.completeBrowserOperation(scope.principalId, scope.operationId, receipt)) {
        const uncertain = unknown();
        this.logReceipt(scope, action, uncertain);
        return uncertain;
      }
      this.logReceipt(scope, action, receipt);
      return receipt;
    } catch {
      const uncertain = unknown();
      this.logReceipt(scope, action, uncertain);
      return uncertain;
    }
  }

  private logReceipt(
    scope: BrowserInvocationScope,
    action: BrowserMutationRequest['action'],
    receipt: BrowserOperationReceipt,
  ): void {
    this.audit.logMutation({
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      action,
      operationId: scope.operationId,
      outcome: receipt.outcome === 'dispatched_verified' ? 'ok'
        : receipt.outcome === 'not_dispatched' ? 'denied' : 'error',
    });
  }

  private cancelReason(controller: AbortController, fallback: string): string {
    return this.cancellationReasons.get(controller) ?? fallback;
  }
}

export const browserMutationCoordinator = new BrowserMutationCoordinator();
