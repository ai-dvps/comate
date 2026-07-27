/**
 * Global GitHub account connection orchestration (KTD1/KTD3/KTD5).
 *
 * Owns the three things R13/KTD3 hinge on:
 *   1. The decrypted token lives ONLY in the module-level holder
 *      ({@link cachedConnection}) — cleared on shutdown, disconnect, and on
 *      every refresh (the adapter is rebuilt for the new token). It is never
 *      written to disk outside the encrypted `app_settings` row.
 *   2. At rest, the whole token bundle is `credential-crypto` ciphertext.
 *   3. Every error that can reach `diagLog` passes through
 *      {@link redactGithubError}; the token endpoints' success bodies (which
 *      contain the token) are never logged.
 *
 * Device Flow + token refresh use a thin, injectable `fetch` so tests can
 * assert request payloads and polling ordering (the U4 test contract demands
 * an observable transport). The Issues adapter is injected via a factory so
 * tests never hit the network.
 */
import { store } from '../storage/sqlite-store.js';
import { encryptCredential, decryptCredential } from '../utils/credential-crypto.js';
import { diagLog } from '../utils/diag-logger.js';
import { redactGithubError } from './github-types.js';
import type { GithubBackendAdapter, GithubConnectionStatus } from './github-types.js';
import { createOctokitAdapter } from './github-client.js';
import type { OctokitAdapterFactory } from './github-client.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REVOKE_URL = (clientId: string) => `https://api.github.com/applications/${clientId}/token`;
const MANUAL_REVOKE_PAT = 'https://github.com/settings/tokens';
const MANUAL_REVOKE_APP = (clientId: string) => `https://github.com/settings/connections/applications/${clientId}`;

/**
 * The registered GitHub App's Client ID (KTD1). Read lazily so tests can set
 * `COMATE_GITHUB_CLIENT_ID` at runtime; the Tauri shell sets it in production.
 */
function getClientId(): string {
  return process.env.COMATE_GITHUB_CLIENT_ID ?? '';
}

/** Refresh this close to expiry. */
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_DEVICE_INTERVAL = 5;
const DEFAULT_DEVICE_EXPIRES = 900;

export type GithubTokenType = 'pat' | 'device-flow';

/** The decrypted connection bundle. Held only in {@link cachedConnection}. */
export interface GithubConnection {
  tokenType: GithubTokenType;
  accessToken: string;
  /** device-flow only; PAT has none. */
  refreshToken: string | null;
  /** ISO expiry of the access token; null for PAT (no expiry known). */
  expiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  login: string | null;
  scope: string | null;
  obtainedAt: string;
}

/** In-flight Device Flow state — memory only, never persisted. */
interface DeviceFlowHandle {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresIn: number;
  startedAt: number;
}

export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export type DevicePollStatus =
  | 'pending'
  | 'success'
  | 'expired'
  | 'access_denied'
  | 'incorrect_device_code'
  | 'slow_down';

/** A surfaced auth error with an HTTP status for the route layer. */
export class GithubAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GithubAuthError';
    this.status = status;
  }
}

// --- In-process holder (the bounded-lifetime decrypted token) ---------------
let cachedConnection: GithubConnection | null = null;
let cachedAdapter: GithubBackendAdapter | null = null;
let inFlightDeviceFlow: DeviceFlowHandle | null = null;

// --- Injectable seams (tests override these; production uses the defaults) --
let fetchImpl: typeof fetch = globalThis.fetch;
let adapterFactory: OctokitAdapterFactory = createOctokitAdapter;
let now: () => number = () => Date.now();

/** @internal Tests inject a controlled fetch to assert payloads/ordering. */
export function __setFetch(fn: typeof fetch): void {
  fetchImpl = fn;
}
/** @internal Tests inject a fake adapter so no octokit/network is used. */
export function __setAdapterFactory(fn: OctokitAdapterFactory): void {
  adapterFactory = fn;
}
/** @internal Tests inject a clock for deterministic expiry math. */
export function __setNow(fn: () => number): void {
  now = fn;
}
/** @internal Wipe the holder + in-flight device flow between tests. */
export function __reset(): void {
  cachedConnection = null;
  cachedAdapter = null;
  inFlightDeviceFlow = null;
}

/** Zero the in-process token holder (shutdown / disconnect). R13/KTD3. */
export function clearCachedToken(): void {
  cachedConnection = null;
  cachedAdapter = null;
}

/** Sidecar shutdown hook — wires into teardownServices(). */
export function shutdown(): void {
  clearCachedToken();
  inFlightDeviceFlow = null;
}

// --- Persistence (encrypted at rest) ----------------------------------------

function persistConnection(conn: GithubConnection): void {
  const encrypted = encryptCredential(JSON.stringify(conn));
  store.setGithubConnection(encrypted);
  cachedConnection = conn;
  cachedAdapter = null; // rebuild the adapter for the new token on next use
}

function loadConnection(): GithubConnection | null {
  const encrypted = store.getGithubConnection();
  if (!encrypted) return null;
  try {
    return JSON.parse(decryptCredential(encrypted)) as GithubConnection;
  } catch (err) {
    diagLog('[github] failed to decrypt stored connection: ' + redactGithubError(err).message);
    return null;
  }
}

/** Populate the holder from storage on first access (lazy — shortest lifetime). */
function ensureLoaded(): GithubConnection | null {
  if (cachedConnection) return cachedConnection;
  cachedConnection = loadConnection();
  return cachedConnection;
}

/** Connection status for the client — never includes a token (R18). */
export function getConnectionStatus(): GithubConnectionStatus {
  const conn = ensureLoaded();
  if (!conn) {
    return { connected: false, tokenType: null, expiresAt: null, login: null };
  }
  return {
    connected: true,
    tokenType: conn.tokenType,
    expiresAt: conn.expiresAt,
    login: conn.login,
  };
}

/** A non-expired access token, refreshing first when device-flow is near expiry. */
export async function getValidToken(): Promise<string | null> {
  const conn = ensureLoaded();
  if (!conn) return null;
  if (conn.tokenType === 'pat' || !conn.expiresAt) return conn.accessToken;

  const expiresAtMs = Date.parse(conn.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs - now() > REFRESH_MARGIN_MS) {
    return conn.accessToken;
  }
  if (!conn.refreshToken) return conn.accessToken; // can't refresh; let the call fail auth-wise
  const refreshed = await refreshTokenGrant(conn.refreshToken);
  if (refreshed) {
    persistConnection(refreshed);
    return refreshed.accessToken;
  }
  return conn.accessToken;
}

/** Build/return the adapter for the current valid token, or null when not connected. */
export async function getAdapter(): Promise<GithubBackendAdapter | null> {
  const token = await getValidToken();
  if (!token) return null;
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = adapterFactory(token);
  return cachedAdapter;
}

// --- Token endpoint helpers --------------------------------------------------

async function postJson(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return body as Record<string, unknown>;
}

function bundleTokenResponse(body: Record<string, unknown>, tokenType: GithubTokenType): GithubConnection {
  const expiresInSec = Number(body.expires_in ?? 0);
  const refreshExpiresInSec = Number(body.refresh_token_expires_in ?? 0);
  return {
    tokenType,
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresAt: expiresInSec > 0 ? new Date(now() + expiresInSec * 1000).toISOString() : null,
    refreshTokenExpiresAt: refreshExpiresInSec > 0 ? new Date(now() + refreshExpiresInSec * 1000).toISOString() : null,
    login: null, // not returned by the token endpoint; resolved elsewhere if at all
    scope: body.scope ? String(body.scope) : null,
    obtainedAt: new Date(now()).toISOString(),
  };
}

// --- Device Flow (KTD1) ------------------------------------------------------

/** Begin a Device Flow: request a device code and hold it for polling. */
export async function startDeviceFlow(): Promise<DeviceCodeStart> {
  const clientId = getClientId();
  if (!clientId) {
    throw new GithubAuthError('GitHub App Client ID is not configured', 500);
  }
  const body = await postJson(DEVICE_CODE_URL, { client_id: clientId, scope: 'repo' });
  const deviceCode = String(body.device_code ?? '');
  const userCode = String(body.user_code ?? '');
  const verificationUri = String(body.verification_uri ?? 'https://github.com/login/device');
  const verificationUriComplete = body.verification_uri_complete ? String(body.verification_uri_complete) : null;
  if (!deviceCode || !userCode) {
    throw new GithubAuthError('Incomplete device-code response from GitHub', 502);
  }
  inFlightDeviceFlow = {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    interval: Number(body.interval ?? DEFAULT_DEVICE_INTERVAL),
    expiresIn: Number(body.expires_in ?? DEFAULT_DEVICE_EXPIRES),
    startedAt: now(),
  };
  return {
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: inFlightDeviceFlow.expiresIn,
    interval: inFlightDeviceFlow.interval,
  };
}

/** Poll the token endpoint once. Honors `slow_down`; clears the handle on terminal states. */
export async function pollDeviceFlow(): Promise<{ status: DevicePollStatus }> {
  const handle = inFlightDeviceFlow;
  if (!handle) {
    throw new GithubAuthError('No device flow in progress', 400);
  }
  if (now() - handle.startedAt > handle.expiresIn * 1000) {
    inFlightDeviceFlow = null;
    return { status: 'expired' };
  }
  const body = await postJson(TOKEN_URL, {
    client_id: getClientId(),
    device_code: handle.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (body.access_token) {
    persistConnection(bundleTokenResponse(body, 'device-flow'));
    inFlightDeviceFlow = null;
    return { status: 'success' };
  }
  const errorCode = String(body.error ?? '');
  switch (errorCode) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      handle.interval += 5;
      return { status: 'slow_down' };
    case 'expired_token':
      inFlightDeviceFlow = null;
      return { status: 'expired' };
    case 'access_denied':
      inFlightDeviceFlow = null;
      return { status: 'access_denied' };
    case 'incorrect_device_code':
      inFlightDeviceFlow = null;
      return { status: 'incorrect_device_code' };
    default:
      throw new GithubAuthError(`Device flow polling failed: ${errorCode || 'unknown error'}`, 502);
  }
}

/** Refresh an expiring device-flow access token using the stored refresh token. */
export async function refreshTokenGrant(refreshToken: string): Promise<GithubConnection | null> {
  const clientId = getClientId();
  if (!clientId) return null;
  try {
    const body = await postJson(TOKEN_URL, {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!body.access_token) {
      diagLog('[github] token refresh failed: ' + String(body.error ?? 'no access_token returned'));
      return null;
    }
    return bundleTokenResponse(body, 'device-flow');
  } catch (err) {
    diagLog('[github] token refresh threw: ' + redactGithubError(err).message);
    return null;
  }
}

// --- PAT fallback (KTD1) -----------------------------------------------------

/** Store a pasted fine-grained PAT. Stored encrypted exactly like a device-flow token. */
export function connectPat(token: string): GithubConnectionStatus {
  const trimmed = (token ?? '').trim();
  if (trimmed.length === 0) {
    throw new GithubAuthError('A personal access token is required', 400);
  }
  persistConnection({
    tokenType: 'pat',
    accessToken: trimmed,
    refreshToken: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    login: null,
    scope: null,
    obtainedAt: new Date(now()).toISOString(),
  });
  return getConnectionStatus();
}

// --- Disconnect + best-effort revocation (R18) -------------------------------

/** Best-effort revoke at GitHub, then always clear local state. Never throws into the caller. */
export async function disconnect(): Promise<{ deepLink?: string }> {
  const conn = ensureLoaded();
  let deepLink: string | undefined;
  if (conn) {
    try {
      deepLink = (await revoke(conn)).deepLink;
    } catch (err) {
      diagLog('[github] disconnect revocation failed: ' + redactGithubError(err).message);
    }
  }
  clearCachedToken();
  store.clearGithubConnection();
  return deepLink ? { deepLink } : {};
}

async function revoke(conn: GithubConnection): Promise<{ deepLink?: string }> {
  if (conn.tokenType === 'pat') {
    // PATs can't be revoked server-side without the client secret; surface manual revoke.
    return { deepLink: MANUAL_REVOKE_PAT };
  }
  const clientId = getClientId();
  if (!clientId) return {};
  // Device-flow App token: best-effort DELETE /applications/{client_id}/token.
  // Without the app private key this 401/422s — expected. The caller clears local
  // state regardless (R18: does not block local deletion on failure).
  try {
    await fetchImpl(REVOKE_URL(clientId), {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({ access_token: conn.accessToken }),
    });
  } catch (err) {
    diagLog('[github] best-effort App token revocation failed: ' + redactGithubError(err).message);
  }
  return { deepLink: MANUAL_REVOKE_APP(clientId) };
}
