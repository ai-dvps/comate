import type {
  BrowserSiteAuthEnvelope,
  BrowserSessionContext,
  BrowserSiteAuthEntry,
  BrowserSiteAuthMeta,
  BrowserSiteAuthStoredEntry,
  WorkspaceSettings,
} from '../models/workspace.js';
import { randomBytes } from 'crypto';
import { decryptCredential, encryptCredential } from '../utils/credential-crypto.js';
import { cookieDomainInScope, storageDomainInScope } from './browser-site-key.js';

/**
 * browser-site-auth — the value-only-in storage discipline for "记住此站点"
 * (KTD-8, U8).
 *
 * The remembered sessionContext is a LIVE, REPLAYABLE session token, so its
 * handling is stricter than the existing secret precedent (whole-bag GET):
 *
 *  - Values only enter through the server-side remember flow
 *    (browser-service.rememberCurrentSite → store.setWorkspaceSiteAuthEntry).
 *  - GET workspace responses pass through `stripSiteAuthValues`, which
 *    reduces every entry to key + metadata (BrowserSiteAuthMeta).
 *  - The PUT route passes through `mergeSiteAuthForUpdate`, which preserves
 *    stored values across whole-bag settings saves and NEVER accepts a
 *    client-supplied sessionContext (a crafted client cannot plant cookies).
 *  - Server-side readers (injection) use `getSiteAuthContext` — the only
 *    value consumer.
 *  - Workspace delete cascades the field with the row; per-site revoke goes
 *    through store.deleteWorkspaceSiteAuthEntry.
 */

// ---------------------------------------------------------------------------
// GET strip — keys + metadata only
// ---------------------------------------------------------------------------

function toMeta(entry: BrowserSiteAuthStoredEntry): BrowserSiteAuthMeta {
  return {
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.lastUsedAt !== undefined && { lastUsedAt: entry.lastUsedAt }),
  };
}

/**
 * Reduce `settings.browserSiteAuth` to its client-safe view (metadata only).
 * The wire shape is deliberately NOT WorkspaceSettings['browserSiteAuth'] —
 * the values are gone by construction. Settings without the field pass
 * through untouched (same reference).
 */
export function stripSiteAuthValues(settings: WorkspaceSettings): WorkspaceSettings {
  const siteAuth = settings.browserSiteAuth;
  if (!siteAuth) return settings;
  const stripped: Record<string, BrowserSiteAuthMeta> = {};
  for (const [key, entry] of Object.entries(siteAuth)) {
    if (entry && typeof entry === 'object') {
      stripped[key] = toMeta(entry);
    }
  }
  // The cast encodes the wire contract: after stripping, browserSiteAuth
  // holds BrowserSiteAuthMeta (no sessionContext). Client models type
  // settings as Record<string, unknown>, so the narrower shape is safe.
  return {
    ...settings,
    browserSiteAuth: stripped as unknown as Record<string, BrowserSiteAuthStoredEntry>,
  };
}

// ---------------------------------------------------------------------------
// PUT field-level merge — values survive whole-bag replaces
// ---------------------------------------------------------------------------

/**
 * Merge the stored browserSiteAuth into an incoming settings bag (PUT route).
 *
 *  - Incoming WITHOUT the field (the normal settings-page save — it never
 *    sends browserSiteAuth): the stored field is preserved verbatim. This is
 *    the write-race fix: a settings save and a remember-site write no longer
 *    clobber each other through whole-bag replacement.
 *  - Incoming WITH the field (a client that fetched the stripped view and
 *    sent it back): the incoming KEY SET decides which stored entries
 *    survive (settings-page revoke-by-save); the stored VALUES are always
 *    kept — incoming sessionContext payloads are ignored by construction, so
 *    a crafted client cannot plant or read back values. Keys the client
 *    invented (absent from storage) are dropped.
 */
export function mergeSiteAuthForUpdate(
  existing: WorkspaceSettings,
  incoming: WorkspaceSettings,
): WorkspaceSettings {
  const stored = existing.browserSiteAuth;
  if (incoming.browserSiteAuth === undefined) {
    if (stored === undefined) return incoming;
    return { ...incoming, browserSiteAuth: stored };
  }
  const merged: Record<string, BrowserSiteAuthStoredEntry> = {};
  for (const key of Object.keys(incoming.browserSiteAuth)) {
    const storedEntry = stored?.[key];
    if (storedEntry) {
      merged[key] = storedEntry;
    }
  }
  return { ...incoming, browserSiteAuth: merged };
}

// ---------------------------------------------------------------------------
// Server-side value access (injection path — the only value consumer)
// ---------------------------------------------------------------------------

/** Read the full stored entry (value included) — server-side use ONLY. */
export function readSiteAuthEntry(
  settings: WorkspaceSettings,
  key: string,
): BrowserSiteAuthEntry | undefined {
  const stored = settings.browserSiteAuth?.[key];
  return stored ? decodeSiteAuthEntry(stored).entry : undefined;
}

export class BrowserSiteAuthReadError extends Error {
  readonly code = 'reauthentication_needed' as const;

  constructor() {
    super('Remembered authentication is unavailable; sign in again.');
    this.name = 'BrowserSiteAuthReadError';
  }
}

export interface DecodedSiteAuthEntry {
  entry: BrowserSiteAuthEntry;
  generation: string;
  legacy: boolean;
}

export function isEncryptedSiteAuthEntry(
  value: BrowserSiteAuthStoredEntry | unknown,
): value is BrowserSiteAuthEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowserSiteAuthEnvelope>;
  return candidate.kind === 'comate.browser-site-auth' && candidate.version === 1 &&
    typeof candidate.ciphertext === 'string' && typeof candidate.generation === 'string';
}

function assertRuntimeEntry(value: unknown): BrowserSiteAuthEntry {
  if (!value || typeof value !== 'object') throw new BrowserSiteAuthReadError();
  const entry = value as Partial<BrowserSiteAuthEntry>;
  if (!entry.sessionContext || !Array.isArray(entry.sessionContext.cookies) ||
      typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string') {
    throw new BrowserSiteAuthReadError();
  }
  return entry as BrowserSiteAuthEntry;
}

export function encodeSiteAuthEntry(
  entry: BrowserSiteAuthEntry,
  generation = randomBytes(24).toString('base64url'),
): BrowserSiteAuthEnvelope {
  const valid = assertRuntimeEntry(entry);
  let ciphertext: string;
  try {
    ciphertext = encryptCredential(JSON.stringify(valid));
  } catch {
    throw new BrowserSiteAuthReadError();
  }
  return {
    kind: 'comate.browser-site-auth',
    version: 1,
    ciphertext,
    generation,
    createdAt: valid.createdAt,
    updatedAt: valid.updatedAt,
    ...(valid.lastUsedAt !== undefined && { lastUsedAt: valid.lastUsedAt }),
  };
}

export function decodeSiteAuthEntry(stored: BrowserSiteAuthStoredEntry): DecodedSiteAuthEntry {
  if (!isEncryptedSiteAuthEntry(stored)) {
    return { entry: assertRuntimeEntry(stored), generation: randomBytes(24).toString('base64url'), legacy: true };
  }
  try {
    const entry = assertRuntimeEntry(JSON.parse(decryptCredential(stored.ciphertext)));
    return { entry, generation: stored.generation, legacy: false };
  } catch {
    throw new BrowserSiteAuthReadError();
  }
}

/** Decode the global row and opportunistically migrate legacy plaintext. */
export function readGlobalSiteAuthEntry(
  store: {
    getGlobalSiteAuth(siteKey: string): string | null;
    setGlobalSiteAuth(siteKey: string, entryJson: string, generation?: string): void;
  },
  siteKey: string,
): DecodedSiteAuthEntry | undefined {
  const json = store.getGlobalSiteAuth(siteKey);
  if (!json) return undefined;
  try {
    const decoded = decodeSiteAuthEntry(JSON.parse(json) as BrowserSiteAuthStoredEntry);
    if (decoded.legacy) store.setGlobalSiteAuth(siteKey, JSON.stringify(decoded.entry), decoded.generation);
    return decoded;
  } catch (error) {
    if (error instanceof BrowserSiteAuthReadError) throw error;
    throw new BrowserSiteAuthReadError();
  }
}

// ---------------------------------------------------------------------------
// Export scoping + injection helpers — a remembered context covers exactly
// its site key
// ---------------------------------------------------------------------------

/**
 * Build the new-document init script that replays web storage for the
 * remembered hostnames. The export keys storage maps by page HOSTNAME
 * (vendored Steel contract), so the script matches on `location.hostname`
 * and writes both stores before any page script runs. Returns null when
 * there is nothing to inject. JSON.stringify embeds the data — the values
 * travel only from the server store into the target page (never into logs,
 * audit, or tool results).
 */
export function buildStorageInitScript(context: {
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}): string | null {
  const data: Record<string, { local?: Record<string, string>; session?: Record<string, string> }> =
    {};
  for (const [domain, values] of Object.entries(context.localStorage ?? {})) {
    data[domain] = { ...(data[domain] ?? {}), local: values };
  }
  for (const [domain, values] of Object.entries(context.sessionStorage ?? {})) {
    data[domain] = { ...(data[domain] ?? {}), session: values };
  }
  if (Object.keys(data).length === 0) return null;
  return `(() => {
  var DATA = ${JSON.stringify(data)};
  var entry = DATA[location.hostname];
  if (!entry) return;
  if (entry.local) {
    for (var k of Object.keys(entry.local)) {
      try { window.localStorage.setItem(k, entry.local[k]); } catch (e) {}
    }
  }
  if (entry.session) {
    for (var k2 of Object.keys(entry.session)) {
      try { window.sessionStorage.setItem(k2, entry.session[k2]); } catch (e) {}
    }
  }
})();`;
}

/**
 * Filter a full browser context dump down to the site key's scope. The
 * vendored Steel export returns cookies BROWSER-WIDE (Network.getAllCookies)
 * and storage keyed by page hostname; storing the unfiltered dump under one
 * key would replay OTHER sites' cookies on injection. Cookie domains are
 * matched by registrable domain; storage keys are page hostnames.
 *
 * IndexedDB is dropped here (R15 scope: cookie-primary auth + web storage —
 * the vendored export captures IndexedDB for open pages, but v1 reinjection
 * has no writer for it; storing it would be dead weight with a token's
 * sensitivity). SessionStorage is kept (same-origin tab state — some stacks
 * park tokens there).
 */
export function filterContextToScope(
  context: {
    cookies?: unknown;
    localStorage?: unknown;
    sessionStorage?: unknown;
  },
  key: string,
): BrowserSessionContext {
  const scoped: BrowserSessionContext = { cookies: [] };
  if (Array.isArray(context.cookies)) {
    scoped.cookies = context.cookies.filter((cookie): cookie is Record<string, unknown> => {
      if (!cookie || typeof cookie !== 'object') return false;
      const domain = (cookie as { domain?: unknown }).domain;
      return typeof domain === 'string' && cookieDomainInScope(domain, key);
    });
  }
  for (const storeKind of ['localStorage', 'sessionStorage'] as const) {
    const storeMap = context[storeKind];
    if (!storeMap || typeof storeMap !== 'object' || Array.isArray(storeMap)) continue;
    const kept: Record<string, Record<string, string>> = {};
    for (const [domain, values] of Object.entries(storeMap as Record<string, unknown>)) {
      if (!storageDomainInScope(domain, key)) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      kept[domain] = values as Record<string, string>;
    }
    if (Object.keys(kept).length > 0) {
      scoped[storeKind] = kept;
    }
  }
  return scoped;
}
