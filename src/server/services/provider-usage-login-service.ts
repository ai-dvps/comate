import { browserService } from './browser-service.js';
import { KIMI_LOGIN_URL, KIMI_SITE_KEY } from './kimi-usage-service.js';
import { BIGMODEL_LOGIN_URL, BIGMODEL_SITE_KEY, BIGMODEL_TOKEN_COOKIE } from './bigmodel-usage-service.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { readGlobalSiteAuthEntry } from './browser-site-auth.js';
import type { Provider } from '../models/provider.js';
import { diagLog } from '../utils/diag-logger.js';
import { providerVendorFromProvenance } from './provider-presets.js';

const USAGE_LOGIN_WORKSPACE_ID = '__provider_usage_login__';

const ORIGIN_EXPR = 'location.hostname';

/** Kimi JWT extraction: candidate localStorage keys, then JWT-shaped cookie. */
const KIMI_EXTRACT_EXPR =
  "(function(){var ks=['kimi-token','token','access_token','accessToken','jwt','authorization','userToken'];" +
  'for(var i=0;i<ks.length;i++){var v=localStorage.getItem(ks[i]);if(v&&v.split(".").length===3)return v;}' +
  "var c=document.cookie||'';var ps=c.split(';');" +
  'for(var j=0;j<ps.length;j++){var eq=ps[j].indexOf("=");var val=eq>=0?ps[j].slice(eq+1).trim():"";' +
  'if(val&&val.split(".").length===3&&val.length>40)return val;}return null;})()';

/** Per-provider capture profile: how to log in and extract the bearer token. */
interface CaptureProfile {
  loginUrl: string;
  siteKey: string;
  extract: { kind: 'expr'; expr: string } | { kind: 'cookie'; cookieName: string };
}

function captureProfileForProvider(provider: Provider): CaptureProfile | null {
  const vendor = providerVendorFromProvenance(provider.configuration?.preset);
  if (vendor === 'kimi') {
    return { loginUrl: KIMI_LOGIN_URL, siteKey: KIMI_SITE_KEY, extract: { kind: 'expr', expr: KIMI_EXTRACT_EXPR } };
  }
  if (vendor === 'bigmodel') {
    return { loginUrl: BIGMODEL_LOGIN_URL, siteKey: BIGMODEL_SITE_KEY, extract: { kind: 'cookie', cookieName: BIGMODEL_TOKEN_COOKIE } };
  }
  return null;
}

export function captureSessionId(providerId: string): string {
  return `usage-login-${providerId}`;
}

export type UsageLoginResult =
  | { status: 'ready' }
  | { status: 'relogin'; reason: 'wrong-origin' | 'no-token-found' };

export class UsageLoginError extends Error {
  constructor(readonly code: 'unsupported', message: string) {
    super(message);
    this.name = 'UsageLoginError';
  }
}

export interface UsageBrowserSurface {
  ensureSession(input: { sessionId: string; workspaceId: string; transient?: boolean }): Promise<unknown>;
  navigateInSession(sessionId: string, url: string): Promise<void>;
  evaluateInSession(sessionId: string, expression: string): Promise<unknown>;
  setControlState(sessionId: string, state: 'user_in_control'): Promise<void> | void;
  teardownSession(sessionId: string): Promise<void>;
  rememberGlobalSiteAuth(
    sessionId: string,
    siteKey: string,
    opts?: { bearerToken?: string; bearerCookieName?: string },
  ): Promise<void>;
}

export class ProviderUsageLoginService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly browser: UsageBrowserSurface = browserService,
  ) {}

  async startLogin(providerId: string): Promise<{ sessionId: string }> {
    const provider = this.sqlite.getProvider(providerId);
    const profile = provider ? captureProfileForProvider(provider) : null;
    if (!profile) {
      throw new UsageLoginError('unsupported', 'Provider does not support usage login.');
    }
    const sessionId = captureSessionId(providerId);
    await this.browser.ensureSession({
      sessionId,
      workspaceId: USAGE_LOGIN_WORKSPACE_ID,
      transient: true,
    });
    await this.browser.navigateInSession(sessionId, profile.loginUrl);
    await this.browser.setControlState(sessionId, 'user_in_control');
    return { sessionId };
  }

  async finalizeLogin(providerId: string): Promise<UsageLoginResult> {
    const provider = this.sqlite.getProvider(providerId);
    const profile = provider ? captureProfileForProvider(provider) : null;
    if (!profile) {
      return { status: 'relogin', reason: 'no-token-found' };
    }
    const sessionId = captureSessionId(providerId);
    try {
      // Origin check: hostname must match the site key (exact or subdomain).
      const hostname = await this.browser.evaluateInSession(sessionId, ORIGIN_EXPR);
      const h = String(hostname);
      if (h !== profile.siteKey && !h.endsWith('.' + profile.siteKey)) {
        diagLog('Usage-login aborted: wrong origin', { hostname: h, expected: profile.siteKey });
        return { status: 'relogin', reason: 'wrong-origin' };
      }

      let bearer: string | null = null;

      if (profile.extract.kind === 'expr') {
        // Kimi: extract JWT via in-page evaluate.
        const v = await this.browser.evaluateInSession(sessionId, profile.extract.expr);
        bearer = typeof v === 'string' && v.length > 0 ? v : null;
        if (!bearer) {
          return { status: 'relogin', reason: 'no-token-found' };
        }
        await this.browser
          .rememberGlobalSiteAuth(sessionId, profile.siteKey, { bearerToken: bearer })
          .catch((err) => diagLog('Global site-auth capture failed', { error: err instanceof Error ? err.message : String(err) }));
      } else {
        // BigModel: capture cookies (httpOnly-safe) and extract by name.
        await this.browser
          .rememberGlobalSiteAuth(sessionId, profile.siteKey, { bearerCookieName: profile.extract.cookieName })
          .catch((err) => diagLog('Global site-auth capture failed', { error: err instanceof Error ? err.message : String(err) }));
        // Read back the extracted bearer.
        try {
          bearer = readGlobalSiteAuthEntry(this.sqlite, profile.siteKey)?.entry.bearerToken ?? null;
        } catch {
          bearer = null;
        }
        if (!bearer) {
          return { status: 'relogin', reason: 'no-token-found' };
        }
      }

      return { status: 'ready' };
    } finally {
      await this.browser.teardownSession(sessionId).catch((err) => {
        diagLog('Usage-login teardown failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  async cancelLogin(providerId: string): Promise<void> {
    await this.browser.teardownSession(captureSessionId(providerId)).catch(() => {});
  }
}

export const providerUsageLoginService = new ProviderUsageLoginService(sqliteStoreSingleton);
