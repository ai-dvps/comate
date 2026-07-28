import { encryptCredential, decryptCredential } from '../utils/credential-crypto.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

/**
 * Normalized, whitelist-shaped usage summary (R14). Built by the query service
 * by reading named fields from the billing response — never by spreading the
 * raw payload, so account-identifying fields cannot reach the client.
 */
export interface UsageSummary {
  used: number | null;
  total: number | null;
  remaining: number | null;
  resetDate: string | null;
  /** ISO timestamp of the last successful fetch (cache freshness, KTD3). */
  lastUpdated: string;
}

/** Status of a provider's usage, surfaced to the client store. */
export type UsageStatus = 'idle' | 'fetching' | 'ready' | 'relogin' | 'no-plan' | 'unsupported' | 'error';

export interface UsageState {
  summary: UsageSummary | null;
  status: UsageStatus;
  lastUpdated: string | null;
}

/** KTD3 / OQ3: a cached usage value older than this is stale and re-fetched. */
const STALENESS_MS = 24 * 60 * 60 * 1000;

/**
 * Server-only owner of a provider's captured usage token and cached usage.
 *
 * The decrypted token lives only in memory (R5: value-only on the server); it
 * is re-decrypted from the `provider_usage_tokens` ciphertext cell on demand
 * and never serialized into any client-facing response. Token writes are
 * identity-guarded (KTD6) so a late browser close/abort from a prior capture
 * cannot clobber a freshly captured JWT.
 */
export class ProviderUsageStore {
  /** Decrypted tokens, held in-memory only (value-only server-side, R5). */
  private readonly tokens = new Map<string, string>();
  /** In-memory usage cache (KTD3); not persisted. */
  private readonly cache = new Map<string, UsageSummary>();
  /** Identity guard (KTD6): the highest capture id accepted per provider. */
  private readonly lastCaptureId = new Map<string, number>();

  constructor(private readonly store: SqliteStore) {}

  /**
   * Decrypt and return the usage token for a provider, or null if none is
   * stored or the ciphertext cannot be decrypted (tamper / wrong key). Never
   * throws to the caller; a null result is treated as "no usable token".
   */
  getToken(providerId: string): string | null {
    const cached = this.tokens.get(providerId);
    if (cached !== undefined) {
      return cached;
    }
    const ciphertext = this.store.getProviderUsageToken(providerId);
    if (!ciphertext) {
      return null;
    }
    try {
      const plaintext = decryptCredential(ciphertext);
      this.tokens.set(providerId, plaintext);
      return plaintext;
    } catch {
      // Tampered ciphertext or wrong key — redacted by credential-crypto;
      // treat as absent rather than surfacing the failure.
      return null;
    }
  }

  /** Whether a usable (decryptable) usage token is stored for the provider. */
  hasToken(providerId: string): boolean {
    return this.getToken(providerId) !== null;
  }

  /**
   * Encrypt and persist the usage token. Identity-guarded (KTD6): a write whose
   * `captureId` is older than the last accepted id is rejected so a stale
   * capture (e.g. a late teardown from a prior login) cannot overwrite a newer
   * token. Returns true when the write was accepted.
   *
   * The caller (login-capture flow) assigns a monotonically increasing
   * `captureId` per capture attempt; the later-started capture wins.
   */
  setToken(providerId: string, plaintext: string, captureId: number): boolean {
    if (captureId < (this.lastCaptureId.get(providerId) ?? 0)) {
      return false;
    }
    const ciphertext = encryptCredential(plaintext);
    this.store.setProviderUsageToken(providerId, ciphertext);
    this.tokens.set(providerId, plaintext);
    this.lastCaptureId.set(providerId, captureId);
    return true;
  }

  /** Remove the token and cached usage for a provider. */
  clearToken(providerId: string): void {
    this.store.clearProviderUsageToken(providerId);
    this.tokens.delete(providerId);
    this.cache.delete(providerId);
    this.lastCaptureId.delete(providerId);
  }

  /** Cached usage summary, or null when none is cached. */
  getCachedUsage(providerId: string): UsageSummary | null {
    return this.cache.get(providerId) ?? null;
  }

  /** Whether the cached value is absent or older than the 24h threshold. */
  isStale(summary: UsageSummary | null): boolean {
    if (!summary) {
      return true;
    }
    return Date.now() - new Date(summary.lastUpdated).getTime() > STALENESS_MS;
  }

  /** Update the in-memory usage cache for a provider. */
  setCachedUsage(providerId: string, summary: UsageSummary): void {
    this.cache.set(providerId, summary);
  }
}
