/**
 * App-global "embedded browser: allow insecure certificates" setting.
 *
 * The embedded browser is headless Chrome for Testing with no certificate-
 * warning interstitial, so internal sites behind a private CA or with a
 * hostname-mismatched cert otherwise hard-fail (surfaced in the viewer as
 * ERR_BLOCKED_BY_CLIENT). The setting is therefore DEFAULT ON: out of the box
 * such sites load; users who want strict certificate validation can turn it off
 * from Settings → General. It disables certificate validation in the embedded
 * browser only (a sandboxed, isolated-profile Chrome for Testing).
 *
 * Persisted in the global app-settings KV store (app-settings-store.ts), so it
 * is readable server-side at Chrome spawn — distinct from the client-local
 * (localStorage) app prefs, which never reach the server.
 */

import { getAppSetting, setAppSetting } from '../storage/app-settings-store.js';

const BROWSER_ALLOW_INSECURE_CERTS_KEY = 'browserAllowInsecureCerts';

/**
 * Effective "allow insecure certificates" value. Default ON: only an explicit
 * stored `false` opts out — absent/`undefined`/a corrupt value keeps it on.
 */
export async function getBrowserAllowInsecureCerts(): Promise<boolean> {
  const value = await getAppSetting<boolean>(BROWSER_ALLOW_INSECURE_CERTS_KEY);
  return value !== false;
}

export async function setBrowserAllowInsecureCerts(value: boolean): Promise<void> {
  await setAppSetting(BROWSER_ALLOW_INSECURE_CERTS_KEY, value);
}
