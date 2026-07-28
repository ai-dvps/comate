import { browserService } from './browser-service.js';
import { providerUsageStore } from './provider-usage-store.js';
import { isKimiCodingPlanProvider, KIMI_LOGIN_URL } from './kimi-usage-service.js';
import { store as sqliteStoreSingleton } from '../storage/sqlite-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { diagLog } from '../utils/diag-logger.js';

/**
 * Sentinel workspace id for capture sessions (KTD1). Provider usage tokens are
 * app-global, so the capture session has no real workspace; this id keeps the
 * registry/workspace-scoped machinery (audit, event routing) satisfied without
 * binding to a real workspace.
 */
const USAGE_LOGIN_WORKSPACE_ID = '__provider_usage_login__';

export function captureSessionId(providerId: string): string {
  return `usage-login-${providerId}`;
}

/** Verify the capture page is exactly on the Kimi origin before any read (R13). */
const ORIGIN_EXPR = 'location.hostname';

/**
 * Defensive JWT extraction (KTD4 / OQ1). Reads a prioritized set of candidate
 * localStorage keys, then a JWT-shaped cookie value. `exportSteelContext` is NOT
 * used (its storage extraction silently degrades to `{}`). The exact storage key
 * is confirmed at smoke time; this returns the first JWT-shaped (three
 * dot-separated base64 segments) value found, or null. Server-side only.
 */
const EXTRACT_EXPR =
  "(function(){var ks=['kimi-token','token','access_token','accessToken','jwt','authorization','userToken'];" +
  'for(var i=0;i<ks.length;i++){var v=localStorage.getItem(ks[i]);if(v&&v.split(".").length===3)return v;}' +
  "var c=document.cookie||'';var ps=c.split(';');" +
  'for(var j=0;j<ps.length;j++){var eq=ps[j].indexOf("=");var val=eq>=0?ps[j].slice(eq+1).trim():"";' +
  'if(val&&val.split(".").length===3&&val.length>40)return val;}return null;})()';

export type UsageLoginResult =
  | { status: 'ready' }
  | { status: 'relogin'; reason: 'wrong-origin' | 'no-token-found' | 'superseded' };

export class UsageLoginError extends Error {
  constructor(readonly code: 'unsupported', message: string) {
    super(message);
    this.name = 'UsageLoginError';
  }
}

/** Minimal browser-surface the capture flow depends on (injectable for tests). */
export interface UsageBrowserSurface {
  ensureSession(input: {
    sessionId: string;
    workspaceId: string;
    transient?: boolean;
  }): Promise<unknown>;
  /**
   * Navigate the session's page via CDP `Page.navigate` (Steel-tracked), NOT a
   * JS location.href assignment — Steel only registers pages that go through
   * Page.navigate, and the viewer-proxy warm-up requires a registered page.
   */
  navigateInSession(sessionId: string, url: string): Promise<void>;
  evaluateInSession(sessionId: string, expression: string): Promise<unknown>;
  setControlState(sessionId: string, state: 'user_in_control'): Promise<void> | void;
  teardownSession(sessionId: string): Promise<void>;
}

export class ProviderUsageLoginService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly browser: UsageBrowserSurface = browserService,
    private readonly usage = providerUsageStore,
  ) {}

  /**
   * Open a transient capture session for the provider and navigate to the Kimi
   * login URL. The client mounts the session's viewer-url in a modal. The
   * session is set to user_in_control so the user can type credentials without
   * a takeover round-trip; transient sessions skip idle-reclaim (KTD1).
   */
  async startLogin(providerId: string): Promise<{ sessionId: string }> {
    const provider = this.sqlite.getProvider(providerId);
    if (!provider || !isKimiCodingPlanProvider(provider)) {
      throw new UsageLoginError('unsupported', 'Provider is not a Kimi coding-plan provider.');
    }
    const sessionId = captureSessionId(providerId);
    await this.browser.ensureSession({
      sessionId,
      workspaceId: USAGE_LOGIN_WORKSPACE_ID,
      transient: true,
    });
    // Navigate via CDP Page.navigate so Steel registers the page (the viewer-
    // proxy warm-up requires a tracked page). A JS location.href assignment is
    // NOT tracked and leaves live-details.pages empty.
    await this.browser.navigateInSession(sessionId, KIMI_LOGIN_URL);
    await this.browser.setControlState(sessionId, 'user_in_control');
    return { sessionId };
  }

  /**
   * Finalize a capture: verify the page origin is exactly www.kimi.com, extract
   * the billing JWT in-page, encrypt+store it (identity-guarded), and tear the
   * capture session down unconditionally (R12 — no live kimi.com session
   * remains, on success, failure, or cancel).
   */
  async finalizeLogin(providerId: string, captureId: number): Promise<UsageLoginResult> {
    const sessionId = captureSessionId(providerId);
    try {
      const hostname = await this.browser.evaluateInSession(sessionId, ORIGIN_EXPR);
      if (hostname !== 'www.kimi.com') {
        diagLog('Kimi usage-login aborted: wrong origin', { hostname: String(hostname) });
        return { status: 'relogin', reason: 'wrong-origin' };
      }
      const jwt = await this.browser.evaluateInSession(sessionId, EXTRACT_EXPR);
      if (typeof jwt !== 'string' || jwt.length === 0) {
        return { status: 'relogin', reason: 'no-token-found' };
      }
      const accepted = this.usage.setToken(providerId, jwt, captureId);
      if (!accepted) {
        return { status: 'relogin', reason: 'superseded' };
      }
      return { status: 'ready' };
    } finally {
      // R12: always tear down — success, failure, or a thrown error.
      await this.browser.teardownSession(sessionId).catch((err) => {
        diagLog('Kimi usage-login teardown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /** Cancel an in-flight capture (user closed the modal). Tears the session down. */
  async cancelLogin(providerId: string): Promise<void> {
    await this.browser.teardownSession(captureSessionId(providerId)).catch(() => {});
  }
}

/** Process singleton. */
export const providerUsageLoginService = new ProviderUsageLoginService(sqliteStoreSingleton);
