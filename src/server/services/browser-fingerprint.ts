/**
 * browser-fingerprint — KTD-12 anti-detection parity for the native browser
 * stack (shell views and the external-CDP fallback, R8).
 *
 * What Steel does by default today (vendored build, cdp.service.js
 * injectFingerprintSafely + scripts/fingerprint.js), and what this module
 * replicates field-by-field over raw CDP:
 *
 *  | Steel default injector                          | Here                              |
 *  |-------------------------------------------------|-----------------------------------|
 *  | page.setUserAgent + Emulation.setUserAgentOverride | Emulation.setUserAgentOverride |
 *  |   (userAgent, acceptLanguage, platform,         |   (same params, derived per host  |
 *  |    userAgentMetadata: brands/fullVersionList/   |    OS + the REAL engine version)  |
 *  |    platform/platformVersion/architecture/model/ |                                   |
 *  |    mobile/bitness/wow64)                        |                                   |
 *  | init script via evaluateOnNewDocument fixing    | Page.addScriptToEvaluateOnNewDocument |
 *  |   navigator.platform/vendor/deviceMemory/       |   fixing the same navigator fields |
 *  |   hardwareConcurrency/userAgentData(+high-      |   + navigator.webdriver + cdc_*    |
 *  |   entropy values)                               |   driver-variable cleanup          |
 *  | Page.setDeviceMetricsOverride (1920x1080)       | intentionally OMITTED — our views |
 *  |                                                 |   are headful with real geometry  |
 *  | WebGL vendor/renderer spoof (videoCard)         | intentionally OMITTED — real GPU  |
 *  |                                                 |   strings are consistent headful  |
 *
 * Two deliberate deviations from Steel's generator (documented in the U7
 * report): (1) the OS matches the HOST platform instead of Steel's hardcoded
 * Linux desktop fingerprint — a visibly-macOS window claiming Linux UA-CH is
 * itself a detection signal; (2) the Chrome version is the attached engine's
 * real version (Browser.getVersion) instead of a random min-136 draw, so UA,
 * UA-CH fullVersionList and engine can never disagree.
 *
 * The init script is idempotent: connectShellPage re-registers it on every
 * attach (registered scripts persist per target, not per CDP session —
 * verified against CfT 151), so a re-attach would stack duplicates; the
 * per-document guard makes re-registration a no-op.
 */

export interface FingerprintBrand {
  brand: string;
  version: string;
}

export interface DesktopFingerprint {
  /** Full UA string for Emulation.setUserAgentOverride. */
  userAgent: string;
  /** acceptLanguage for the override AND the Accept-Language header. */
  acceptLanguage: string;
  /** CDP platform token AND navigator.platform is derived from os below. */
  userAgentMetadata: {
    brands: FingerprintBrand[];
    fullVersionList: FingerprintBrand[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
  /** navigator.* fields the init script pins. */
  navigator: {
    platform: string;
    vendor: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number;
  };
}

interface OsProfile {
  uaPlatform: string;
  uaChPlatform: string;
  navigatorPlatform: string;
  platformVersion: string;
}

const OS_PROFILES: Record<string, OsProfile> = {
  darwin: {
    uaPlatform: 'Macintosh; Intel Mac OS X 10_15_7',
    uaChPlatform: 'macOS',
    navigatorPlatform: 'MacIntel',
    // Frozen UA-CH platform version real Chrome reports on modern macOS.
    platformVersion: '15.0.0',
  },
  win32: {
    uaPlatform: 'Windows NT 10.0; Win64; x64',
    uaChPlatform: 'Windows',
    navigatorPlatform: 'Win32',
    platformVersion: '15.0.0',
  },
  linux: {
    uaPlatform: 'X11; Linux x86_64',
    uaChPlatform: 'Linux',
    navigatorPlatform: 'Linux x86_64',
    platformVersion: '6.8.0',
  },
};

export interface BuildFingerprintOptions {
  /** Host OS (process.platform). Unknown values fall back to linux. */
  platform: string;
  /** Host CPU arch (process.arch) — Apple Silicon reports arm in UA-CH. */
  arch?: string;
  /**
   * Full Chrome version of the ATTACHED engine (from Browser.getVersion's
   * product field), e.g. '151.0.7922.34'. Keeps UA / UA-CH / engine in lockstep.
   */
  chromeVersion: string;
  /** Defaults to 'en-US,en' (Steel's locales: ["en-US", "en"]). */
  acceptLanguage?: string;
}

/** Parse 'Chrome/151.0.7922.34' (or a UA string containing it) to the version. */
export function parseChromeVersion(product: string): string | undefined {
  const match = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(product);
  return match?.[1];
}

export function buildDesktopFingerprint(options: BuildFingerprintOptions): DesktopFingerprint {
  const profile = OS_PROFILES[options.platform] ?? OS_PROFILES.linux!;
  const fullVersion = options.chromeVersion;
  const major = fullVersion.split('.')[0] ?? fullVersion;
  const acceptLanguage = options.acceptLanguage ?? 'en-US,en';
  // Real desktop Chrome UA-CH brand set (Chrome ≥ 136 shape).
  const brands: FingerprintBrand[] = [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  const fullVersionList: FingerprintBrand[] = [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: fullVersion },
    { brand: 'Google Chrome', version: fullVersion },
  ];
  return {
    userAgent:
      `Mozilla/5.0 (${profile.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${fullVersion} Safari/537.36`,
    acceptLanguage,
    userAgentMetadata: {
      brands,
      fullVersionList,
      fullVersion,
      platform: profile.uaChPlatform,
      platformVersion: profile.platformVersion,
      architecture:
        options.platform === 'darwin' && options.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
    navigator: {
      platform: profile.navigatorPlatform,
      vendor: 'Google Inc.',
      languages: acceptLanguage.split(',').map((part) => part.trim()),
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
  };
}

/** Params for CDP `Emulation.setUserAgentOverride` (Steel's override shape). */
export function userAgentOverrideParams(
  fingerprint: DesktopFingerprint,
): Record<string, unknown> {
  return {
    userAgent: fingerprint.userAgent,
    acceptLanguage: fingerprint.acceptLanguage,
    platform: fingerprint.navigator.platform,
    userAgentMetadata: {
      brands: fingerprint.userAgentMetadata.brands,
      fullVersionList: fingerprint.userAgentMetadata.fullVersionList,
      fullVersion: fingerprint.userAgentMetadata.fullVersion,
      platform: fingerprint.userAgentMetadata.platform,
      platformVersion: fingerprint.userAgentMetadata.platformVersion,
      architecture: fingerprint.userAgentMetadata.architecture,
      model: fingerprint.userAgentMetadata.model,
      mobile: fingerprint.userAgentMetadata.mobile,
      bitness: fingerprint.userAgentMetadata.bitness,
      wow64: fingerprint.userAgentMetadata.wow64,
    },
  };
}

/**
 * The new-document init script (Page.addScriptToEvaluateOnNewDocument). Pins
 * the navigator surface Steel's injector pins, removes the automation tells
 * (navigator.webdriver, chromedriver's cdc_ / $cdc_ globals), and mocks
 * navigator.userAgentData — Electron's renderer does not always expose
 * userAgentData consistent with the UA override, so the mock is unconditional
 * and mirrors the override metadata exactly. Idempotent per document (the
 * transport re-registers on every attach).
 */
export function buildFingerprintInitScript(fingerprint: DesktopFingerprint): string {
  const meta = fingerprint.userAgentMetadata;
  const highEntropy = {
    architecture: meta.architecture,
    bitness: meta.bitness,
    brands: meta.brands,
    fullVersionList: meta.fullVersionList,
    mobile: meta.mobile,
    model: meta.model,
    platform: meta.platform,
    platformVersion: meta.platformVersion,
    uaFullVersion: meta.fullVersion,
    wow64: meta.wow64,
  };
  return `(() => {
  if (window.__comateFingerprintApplied) return;
  try {
    Object.defineProperty(window, '__comateFingerprintApplied', {
      value: true, configurable: false, enumerable: false, writable: false,
    });
  } catch (e) { return; }

  var META = ${JSON.stringify({
    brands: meta.brands,
    mobile: meta.mobile,
    platform: meta.platform,
  })};
  var HIGH_ENTROPY = ${JSON.stringify(highEntropy)};
  var NAV = ${JSON.stringify(fingerprint.navigator)};

  // chromedriver / automation leftovers (Steel's fingerprint.js deletes these).
  var CDC = [
    'cdc_adoQpoAZQpn9p_Array', 'cdc_adoQpoAZQpn9p_Object', 'cdc_adoQpoAZQpn9p_String',
    'cdc_adoQpoAZQpn9p_Promise', 'cdc_adoQpoAZQpn9p_Proxy', 'cdc_adoQpoAZQpn9p_Symbol',
    'cdc_adoQpoAZQpn9p_JSON', 'cdc_adoQpoAZQpn9p_Function',
    '$cdc_asdjflasutopfhvcZLmcfl_', '$chrome_asyncScriptInfo', '__$webdriverAsyncExecutor',
  ];
  for (var i = 0; i < CDC.length; i++) {
    try { delete window[CDC[i]]; } catch (e) {}
  }

  function define(target, name, getter) {
    try {
      Object.defineProperty(target, name, { get: getter, configurable: true });
    } catch (e) {}
  }

  var uaData = {
    brands: META.brands,
    mobile: META.mobile,
    platform: META.platform,
    getHighEntropyValues: function (hints) {
      var out = { brands: META.brands, mobile: META.mobile, platform: META.platform };
      if (Array.isArray(hints)) {
        for (var j = 0; j < hints.length; j++) {
          var hint = hints[j];
          if (hint === 'uaFullVersion') out.uaFullVersion = HIGH_ENTROPY.uaFullVersion;
          else if (hint === 'fullVersionList') out.fullVersionList = HIGH_ENTROPY.fullVersionList;
          else if (Object.prototype.hasOwnProperty.call(HIGH_ENTROPY, hint)) out[hint] = HIGH_ENTROPY[hint];
        }
      }
      return Promise.resolve(out);
    },
    toJSON: function () {
      return { brands: META.brands, mobile: META.mobile, platform: META.platform };
    },
  };

  define(Navigator.prototype, 'webdriver', function () { return undefined; });
  define(Navigator.prototype, 'platform', function () { return NAV.platform; });
  define(Navigator.prototype, 'vendor', function () { return NAV.vendor; });
  define(Navigator.prototype, 'languages', function () { return NAV.languages.slice(); });
  define(Navigator.prototype, 'hardwareConcurrency', function () { return NAV.hardwareConcurrency; });
  define(Navigator.prototype, 'deviceMemory', function () { return NAV.deviceMemory; });
  define(Navigator.prototype, 'userAgentData', function () { return uaData; });
})();`;
}
