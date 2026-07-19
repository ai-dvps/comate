import { getDomain } from 'tldts';

/**
 * browser-site-key — the single home of the site-key rule (KTD-8, U8).
 *
 * Two consumers with deliberately different strictness:
 *
 *  - `registrableDomain(url)` powers the U4 navigation gate's cross-domain
 *    ledger. It must ALWAYS produce a grouping key (IP literals and
 *    single-label hosts included, port-scoped) so the first-cross
 *    confirmation can never be dodged by an exotic host.
 *
 *  - `siteKeyForUrl(rawUrl)` powers "记住此站点" (remember-site) storage and
 *    injection matching. It is stricter: IP-literal hosts are REFUSED
 *    (`ip-literal` — cross-network semantics are unstable: the same address
 *    is a different site on another network), and non-http(s) / unparseable
 *    input is rejected outright.
 *
 * The rule itself (both paths):
 *  - Public web hosts: the PSL eTLD+1 via tldts with `allowPrivateDomains`
 *    (so `user.github.io` keys as `user.github.io`, never leaking across all
 *    of `github.io`; `example.co.uk` keys as `example.co.uk`, never as
 *    `co.uk`). A host that IS a public suffix (getDomain → null) keys as
 *    itself.
 *  - localhost / single-label / IP literals: hostname + PORT (cookies ignore
 *    ports per RFC 6265, but the stored contexts must not cross-inject
 *    between `localhost:3000` and `:8080`).
 *  - IDN: WHATWG URL already normalizes the hostname to punycode
 *    (`bücher.de` → `xn--bcher-kva.de`), so keys are punycode-normalized by
 *    construction; casing is lowercased by the URL parser as well.
 */

/** tldts options: private PSL suffixes (github.io, appspot.com, …) count. */
const TLDTS_OPTIONS = { allowPrivateDomains: true };

export function isIpLiteralHost(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6 literals arrive bracketed from URL.hostname ("[::1]").
  return hostname.includes(':');
}

function isSingleLabelHost(hostname: string): boolean {
  return !hostname.includes('.');
}

/**
 * eTLD+1 grouping for the navigation ledger. IP literals, localhost and
 * single-label hosts keep their port (those hosts are port-scoped);
 * multi-label public hosts are port-insensitive.
 */
export function registrableDomain(url: URL): string {
  let hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  const port = url.port ? `:${url.port}` : '';
  if (!hostname) return `(empty)${port}`;
  if (isIpLiteralHost(hostname)) return `${hostname}${port}`;
  if (isSingleLabelHost(hostname)) return `${hostname}${port}`;
  const domain = getDomain(hostname, TLDTS_OPTIONS);
  // getDomain is null when the whole hostname IS a public suffix (co.uk,
  // github.io) — group those as themselves (over-grouping, never under-).
  return domain ?? hostname;
}

export type SiteKeyResult =
  | { ok: true; key: string; origin: string }
  | {
      ok: false;
      reason: 'invalid' | 'not-http' | 'ip-literal';
    };

/**
 * Strict remember-site key. Returns the storage/injection key for an http(s)
 * URL, or a typed refusal: IP-literal hosts may not be remembered (KTD-8 —
 * the same address is a different site on another network, so replaying its
 * credentials is unsound).
 */
export function siteKeyForUrl(rawUrl: string): SiteKeyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not-http' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isIpLiteralHost(hostname)) {
    return { ok: false, reason: 'ip-literal' };
  }
  return { ok: true, key: registrableDomain(parsed), origin: parsed.origin };
}

/**
 * True when a cookie's domain attribute belongs to the site key's scope.
 * Cookie domains arrive as `.example.com` / `app.example.com` / `localhost`;
 * the port-less cookie spec means localhost cookies are shared across ports
 * (documented residual — the port-scoped key prevents STORED contexts from
 * cross-injecting, it cannot partition live cookie jars).
 */
export function cookieDomainInScope(cookieDomain: string, key: string): boolean {
  const normalized = cookieDomain.replace(/^\./, '').toLowerCase();
  if (!normalized) return false;
  // Port-scoped keys (localhost:3000, 127.0.0.1:8080) match the bare host.
  const keyHost = key.includes(':') && isSingleLabelHost(key.split(':')[0])
    ? key.split(':')[0]
    : key;
  if (isIpLiteralHost(keyHost)) {
    return normalized === keyHost;
  }
  if (isSingleLabelHost(keyHost)) {
    return normalized === keyHost;
  }
  return getDomain(normalized, TLDTS_OPTIONS) === keyHost || normalized === keyHost;
}

/**
 * True when a storage-map domain key (the context export keys localStorage /
 * sessionStorage / indexedDB by page hostname) belongs to the site key.
 */
export function storageDomainInScope(storageDomain: string, key: string): boolean {
  return cookieDomainInScope(storageDomain, key);
}
