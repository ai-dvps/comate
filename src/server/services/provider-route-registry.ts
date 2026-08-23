import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { ConverterLimits } from './codex-chat-route/errors.js';

export interface ProviderRouteUpstreamSnapshot {
  providerId: string;
  baseUrl: string;
  credential: string;
  model: string;
  promptCacheRouting?: 'auto' | 'unsupported';
  effortWireMapping?: Readonly<Record<string, string>>;
  suppressSamplingParameters?: boolean;
  converterLimits?: Partial<ConverterLimits>;
}

export interface ProviderRouteRegistration {
  sessionId: string;
  generation: string;
  upstream: ProviderRouteUpstreamSnapshot;
}

export interface ProviderRouteLeaseIdentity {
  routeId: string;
  sessionId: string;
  generation: string;
}

export interface ProviderRouteLease extends ProviderRouteLeaseIdentity {
  /** Delivered only to the owning Codex runtime and never retained by the registry. */
  bearer: string;
}

export interface ProviderRouteRegistryLimits {
  maxLeases: number;
  maxActiveRequests: number;
  maxActiveRequestsPerLease: number;
  maxHistoryBytes: number;
  maxHistoryBytesPerLease: number;
  maxBufferedResponseBytes: number;
  maxBufferedResponseBytesPerLease: number;
}

const DEFAULT_LIMITS: Readonly<ProviderRouteRegistryLimits> = Object.freeze({
  maxLeases: 64,
  maxActiveRequests: 32,
  maxActiveRequestsPerLease: 4,
  maxHistoryBytes: 32 * 1024 * 1024,
  maxHistoryBytesPerLease: 4 * 1024 * 1024,
  maxBufferedResponseBytes: 32 * 1024 * 1024,
  maxBufferedResponseBytesPerLease: 8 * 1024 * 1024,
});

export type ProviderRouteFailureCode =
  | 'lease_capacity'
  | 'request_capacity'
  | 'history_capacity'
  | 'buffer_capacity'
  | 'route_unavailable';

export class ProviderRouteRegistryError extends Error {
  constructor(readonly code: ProviderRouteFailureCode) {
    super(code === 'route_unavailable'
      ? 'The Provider route is unavailable.'
      : 'The Provider route is at capacity.');
    this.name = 'ProviderRouteRegistryError';
  }
}

interface StoredLease extends ProviderRouteLeaseIdentity {
  credentialDigest: Buffer;
  upstream: Readonly<ProviderRouteUpstreamSnapshot>;
  requests: Map<string, ActiveRequestRecord>;
  historyBytes: number;
  bufferedBytes: number;
  state: 'ready' | 'closing';
}

interface ActiveRequestRecord {
  controller: AbortController;
  historyBytes: number;
  bufferedBytes: number;
}

export interface AuthorizedProviderRoute {
  readonly identity: ProviderRouteLeaseIdentity;
  readonly upstream: Readonly<ProviderRouteUpstreamSnapshot>;
}

export interface ProviderRouteRequestHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  abort(): void;
  reserveHistory(bytes: number): void;
  reserveBuffered(bytes: number): void;
  releaseBuffered(bytes: number): void;
  finish(): void;
}

export interface ProviderRouteSafeStatus {
  state: 'ready' | 'missing';
  providerId?: string;
  generation?: string;
  activeRequests: number;
  historyBytes: number;
  bufferedResponseBytes: number;
}

export interface ProviderRouteRegistryStatus {
  leases: number;
  activeRequests: number;
  historyBytes: number;
  bufferedResponseBytes: number;
}

function positiveLimits(overrides?: Partial<ProviderRouteRegistryLimits>): ProviderRouteRegistryLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Provider route limits must be positive integers');
  }
  return limits;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update('comate-provider-route-v1\0').update(token).digest();
}

function credentialMatches(token: string, expectedDigest: Buffer): boolean {
  const actual = tokenDigest(token);
  return timingSafeEqual(actual, expectedDigest);
}

function opaqueValue(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function freezeSnapshot(input: ProviderRouteUpstreamSnapshot): Readonly<ProviderRouteUpstreamSnapshot> {
  return Object.freeze({
    ...input,
    ...(input.effortWireMapping ? { effortWireMapping: Object.freeze({ ...input.effortWireMapping }) } : {}),
    ...(input.converterLimits ? { converterLimits: Object.freeze({ ...input.converterLimits }) } : {}),
  });
}

function registrationIsValid(input: ProviderRouteRegistration): boolean {
  if (!input.sessionId || !input.generation || !input.upstream.providerId
      || !input.upstream.model.trim() || !input.upstream.credential.trim()) return false;
  try {
    const url = new URL(input.upstream.baseUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (url.port === '' || url.port === '443') && Boolean(url.hostname)
      && isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0;
  } catch {
    return false;
  }
}

export class ProviderRouteRegistry {
  private readonly limits: ProviderRouteRegistryLimits;
  private readonly leases = new Map<string, StoredLease>();
  private readonly owners = new Map<string, string>();
  private activeRequests = 0;
  private historyBytes = 0;
  private bufferedBytes = 0;

  constructor(options?: { limits?: Partial<ProviderRouteRegistryLimits> }) {
    this.limits = positiveLimits(options?.limits);
  }

  register(input: ProviderRouteRegistration): ProviderRouteLease {
    if (!registrationIsValid(input)) throw new ProviderRouteRegistryError('route_unavailable');
    const ownerKey = this.ownerKey(input.sessionId, input.generation);
    if (this.owners.has(ownerKey)) throw new ProviderRouteRegistryError('route_unavailable');
    if (this.leases.size >= this.limits.maxLeases) throw new ProviderRouteRegistryError('lease_capacity');
    const routeId = opaqueValue('route');
    const bearer = opaqueValue('cap');
    const lease: StoredLease = {
      routeId,
      sessionId: input.sessionId,
      generation: input.generation,
      credentialDigest: tokenDigest(bearer),
      upstream: freezeSnapshot(input.upstream),
      requests: new Map(),
      historyBytes: 0,
      bufferedBytes: 0,
      state: 'ready',
    };
    this.leases.set(routeId, lease);
    this.owners.set(ownerKey, routeId);
    return { routeId, bearer, sessionId: input.sessionId, generation: input.generation };
  }

  authorize(routeId: string, bearer: string): AuthorizedProviderRoute | null {
    const lease = this.leases.get(routeId);
    if (!lease || lease.state !== 'ready' || !credentialMatches(bearer, lease.credentialDigest)) return null;
    return {
      identity: { routeId: lease.routeId, sessionId: lease.sessionId, generation: lease.generation },
      upstream: lease.upstream,
    };
  }

  startRequest(route: AuthorizedProviderRoute, historyBytes: number): ProviderRouteRequestHandle {
    const lease = this.currentLease(route.identity);
    if (!lease || route.upstream !== lease.upstream) throw new ProviderRouteRegistryError('route_unavailable');
    if (this.activeRequests >= this.limits.maxActiveRequests
        || lease.requests.size >= this.limits.maxActiveRequestsPerLease) {
      throw new ProviderRouteRegistryError('request_capacity');
    }
    if (!Number.isSafeInteger(historyBytes) || historyBytes < 0
        || this.historyBytes + historyBytes > this.limits.maxHistoryBytes
        || lease.historyBytes + historyBytes > this.limits.maxHistoryBytesPerLease) {
      throw new ProviderRouteRegistryError('history_capacity');
    }
    const id = opaqueValue('request');
    const record: ActiveRequestRecord = { controller: new AbortController(), historyBytes, bufferedBytes: 0 };
    lease.requests.set(id, record);
    lease.historyBytes += historyBytes;
    this.historyBytes += historyBytes;
    this.activeRequests += 1;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.finishRequest(lease, id, record);
    };
    return {
      id,
      signal: record.controller.signal,
      abort: () => record.controller.abort(),
      reserveHistory: (bytes) => this.reserveHistory(lease, record, bytes),
      reserveBuffered: (bytes) => this.reserveBuffered(lease, record, bytes),
      releaseBuffered: (bytes) => this.releaseBuffered(lease, record, bytes),
      finish,
    };
  }

  close(identity: ProviderRouteLeaseIdentity): boolean {
    const lease = this.currentLease(identity);
    if (!lease) return false;
    lease.state = 'closing';
    this.leases.delete(identity.routeId);
    if (this.owners.get(this.ownerKey(identity.sessionId, identity.generation)) === identity.routeId) {
      this.owners.delete(this.ownerKey(identity.sessionId, identity.generation));
    }
    for (const record of lease.requests.values()) record.controller.abort();
    for (const [id, record] of [...lease.requests]) this.finishRequest(lease, id, record);
    return true;
  }

  closeAll(): void {
    for (const lease of [...this.leases.values()]) this.close(lease);
  }

  status(identity: ProviderRouteLeaseIdentity): ProviderRouteSafeStatus {
    const lease = this.currentLease(identity);
    if (!lease) return { state: 'missing', activeRequests: 0, historyBytes: 0, bufferedResponseBytes: 0 };
    return {
      state: 'ready',
      providerId: lease.upstream.providerId,
      generation: lease.generation,
      activeRequests: lease.requests.size,
      historyBytes: lease.historyBytes,
      bufferedResponseBytes: lease.bufferedBytes,
    };
  }

  processStatus(): ProviderRouteRegistryStatus {
    return {
      leases: this.leases.size,
      activeRequests: this.activeRequests,
      historyBytes: this.historyBytes,
      bufferedResponseBytes: this.bufferedBytes,
    };
  }

  private currentLease(identity: ProviderRouteLeaseIdentity): StoredLease | null {
    const lease = this.leases.get(identity.routeId);
    return lease?.sessionId === identity.sessionId && lease.generation === identity.generation && lease.state === 'ready'
      ? lease
      : null;
  }

  private ownerKey(sessionId: string, generation: string): string {
    return `${sessionId.length}:${sessionId}${generation}`;
  }

  private reserveBuffered(lease: StoredLease, record: ActiveRequestRecord, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0
        || this.bufferedBytes + bytes > this.limits.maxBufferedResponseBytes
        || lease.bufferedBytes + bytes > this.limits.maxBufferedResponseBytesPerLease) {
      throw new ProviderRouteRegistryError('buffer_capacity');
    }
    record.bufferedBytes += bytes;
    lease.bufferedBytes += bytes;
    this.bufferedBytes += bytes;
  }

  private reserveHistory(lease: StoredLease, record: ActiveRequestRecord, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0
        || this.historyBytes + bytes > this.limits.maxHistoryBytes
        || lease.historyBytes + bytes > this.limits.maxHistoryBytesPerLease) {
      throw new ProviderRouteRegistryError('history_capacity');
    }
    record.historyBytes += bytes;
    lease.historyBytes += bytes;
    this.historyBytes += bytes;
  }

  private releaseBuffered(lease: StoredLease, record: ActiveRequestRecord, bytes: number): void {
    const released = Math.min(Math.max(0, bytes), record.bufferedBytes);
    record.bufferedBytes -= released;
    lease.bufferedBytes -= released;
    this.bufferedBytes -= released;
  }

  private finishRequest(lease: StoredLease, id: string, record: ActiveRequestRecord): void {
    if (!lease.requests.delete(id)) return;
    lease.historyBytes -= record.historyBytes;
    this.historyBytes -= record.historyBytes;
    lease.bufferedBytes -= record.bufferedBytes;
    this.bufferedBytes -= record.bufferedBytes;
    this.activeRequests -= 1;
    record.historyBytes = 0;
    record.bufferedBytes = 0;
  }
}

export const providerRouteRegistry = new ProviderRouteRegistry();
