export const ANALYTICS_CONSENT_VERSION = 1;
export const CONSENT_STORAGE_KEY = 'comate-analytics-consent';

const OWNED_STORAGE_PREFIX = 'comate-analytics-';
const EVENT_NAMES = ['download_cta_click', 'release_download_click'] as const;
const LOCALES = ['zh', 'en'] as const;
const CTA_LOCATIONS = [
  'nav_menu',
  'nav_primary',
  'mobile_nav_menu',
  'mobile_nav_primary',
  'footer_product',
  'home_hero',
  'home_closing',
  'features_header',
  'features_closing',
  'usage_closing',
  'download_primary',
  'download_secondary',
  'download_all_releases',
  'download_release_notes',
] as const;
const PLATFORMS = ['macos', 'windows', 'linux', 'all'] as const;
const DESTINATION_STAGES = ['download_page', 'github_releases'] as const;
const PAYLOAD_KEYS = ['locale', 'cta_location', 'platform', 'destination_stage'] as const;

type ConsentChoice = 'unknown' | 'granted' | 'denied';
type Locale = (typeof LOCALES)[number];
type CtaLocation = (typeof CTA_LOCATIONS)[number];
type Platform = (typeof PLATFORMS)[number];
type DestinationStage = (typeof DESTINATION_STAGES)[number];
type GtagCommand = unknown[];

export interface AnalyticsPayload {
  locale: Locale;
  cta_location: CtaLocation;
  platform: Platform;
  destination_stage: DestinationStage;
}

interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

const UNAVAILABLE_STORAGE: StorageLike = {
  length: 0,
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  key: () => null,
};

export interface AnalyticsEnvironment {
  dataLayer: unknown[][];
  location: { origin: string; pathname: string };
  storage: StorageLike;
  loadTag: (measurementId: string) => void;
  cookieNames: () => string[];
  expireCookie: (name: string) => void;
}

const DENIED_CONSENT = Object.freeze({
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
});

function safeStorage<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

export function readConsent(storage: StorageLike): ConsentChoice {
  const raw = safeStorage(() => storage.getItem(CONSENT_STORAGE_KEY), null);
  if (!raw) return 'unknown';

  try {
    const parsed = JSON.parse(raw) as { version?: unknown; choice?: unknown };
    if (
      parsed.version === ANALYTICS_CONSENT_VERSION &&
      (parsed.choice === 'granted' || parsed.choice === 'denied')
    ) {
      return parsed.choice;
    }
  } catch {
    // Invalid site-owned state is treated as no choice.
  }

  safeStorage(() => storage.removeItem(CONSENT_STORAGE_KEY), undefined);
  return 'unknown';
}

function writeConsent(storage: StorageLike, choice: Exclude<ConsentChoice, 'unknown'>) {
  safeStorage(
    () => storage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ version: ANALYTICS_CONSENT_VERSION, choice }),
    ),
    undefined,
  );
}

function clearOwnedAnalyticsState(environment: AnalyticsEnvironment) {
  for (const name of environment.cookieNames()) {
    if (name === '_ga' || name.startsWith('_ga_')) {
      environment.expireCookie(name);
    }
  }

  const ownedKeys: string[] = [];
  const storageLength = safeStorage(() => environment.storage.length, 0);
  for (let index = 0; index < storageLength; index += 1) {
    const key = safeStorage(() => environment.storage.key(index), null);
    if (key?.startsWith(OWNED_STORAGE_PREFIX) && key !== CONSENT_STORAGE_KEY) {
      ownedKeys.push(key);
    }
  }
  for (const key of ownedKeys) {
    safeStorage(() => environment.storage.removeItem(key), undefined);
  }
}

function validMeasurementId(measurementId: string) {
  return /^G-[A-Z0-9]+$/.test(measurementId);
}

function sanitizedPageLocation(location: AnalyticsEnvironment['location']) {
  const path = location.pathname;
  const websitePath = /^\/comate\/(?:zh|en)(?:\/(?:features|usage|download|about|faq|404))?\/?$/.test(path)
    || path === '/comate/'
    ? path
    : '/comate/';
  return `${location.origin}${websitePath}`;
}

function payloadIsAllowed(payload: AnalyticsPayload) {
  const keys = Object.keys(payload);
  return keys.length === PAYLOAD_KEYS.length
    && keys.every((key) => (PAYLOAD_KEYS as readonly string[]).includes(key))
    && (LOCALES as readonly string[]).includes(payload.locale)
    && (CTA_LOCATIONS as readonly string[]).includes(payload.cta_location)
    && (PLATFORMS as readonly string[]).includes(payload.platform)
    && (DESTINATION_STAGES as readonly string[]).includes(payload.destination_stage);
}

export function createAnalytics(
  measurementId: string,
  environment: AnalyticsEnvironment,
  dispatch: (command: GtagCommand) => void = (command) => environment.dataLayer.push(command),
) {
  let choice = readConsent(environment.storage);
  let initialized = false;

  const command = (...args: unknown[]) => {
    try {
      dispatch(args);
      return true;
    } catch {
      return false;
    }
  };

  const initialize = () => {
    if (initialized || choice !== 'granted' || !validMeasurementId(measurementId)) return false;

    // The defaults and privacy settings are established before the external tag can execute.
    command('consent', 'default', DENIED_CONSENT);
    command('set', 'ads_data_redaction', true);
    command('set', 'allow_ad_personalization_signals', false);
    command('consent', 'update', { ...DENIED_CONSENT, analytics_storage: 'granted' });
    try {
      environment.loadTag(measurementId);
    } catch {
      return false;
    }
    command('js', new Date());
    const pageLocation = sanitizedPageLocation(environment.location);
    command('config', measurementId, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: pageLocation,
      page_referrer: '',
    });
    command('event', 'page_view', {
      page_location: pageLocation,
      page_referrer: '',
      transport_type: 'beacon',
    });
    initialized = true;
    return true;
  };

  const track = (eventName: string, payload: AnalyticsPayload) => {
    if (
      choice !== 'granted'
      || !initialized
      || !(EVENT_NAMES as readonly string[]).includes(eventName)
      || !payloadIsAllowed(payload)
    ) {
      return false;
    }

    return command('event', eventName, {
      ...payload,
      page_location: sanitizedPageLocation(environment.location),
      page_referrer: '',
      transport_type: 'beacon',
    });
  };

  return {
    get consent(): ConsentChoice {
      return choice;
    },
    bootstrap: initialize,
    grant() {
      choice = 'granted';
      writeConsent(environment.storage, choice);
      return initialize();
    },
    deny() {
      choice = 'denied';
      writeConsent(environment.storage, choice);
      clearOwnedAnalyticsState(environment);
    },
    revoke() {
      if (initialized) command('consent', 'update', DENIED_CONSENT);
      choice = 'denied';
      initialized = false;
      writeConsent(environment.storage, choice);
      clearOwnedAnalyticsState(environment);
    },
    track,
    trackDownloadCta(payload: AnalyticsPayload) {
      return track('download_cta_click', payload);
    },
    trackReleaseDownload(payload: AnalyticsPayload, navigationFallback?: () => void) {
      let sent = false;
      try {
        sent = track('release_download_click', payload);
      } finally {
        // Callers may use this as an immediate fallback; analytics never owns navigation timing.
        try {
          navigationFallback?.();
        } catch {
          // A navigation callback is outside analytics and must not escape this boundary.
        }
      }
      return sent;
    },
  };
}

export function createBrowserEnvironment(): AnalyticsEnvironment {
  const browserWindow = window as typeof window & { dataLayer?: unknown[][] };
  browserWindow.dataLayer ??= [];
  return {
    dataLayer: browserWindow.dataLayer,
    location: window.location,
    storage: safeStorage(() => window.localStorage, UNAVAILABLE_STORAGE),
    loadTag(measurementId) {
      if (document.querySelector('script[data-comate-google-tag]')) return;
      const script = document.createElement('script');
      script.async = true;
      script.dataset.comateGoogleTag = 'true';
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
      document.head.append(script);
    },
    cookieNames() {
      return document.cookie
        .split(';')
        .map((part) => part.trim().split('=')[0])
        .filter(Boolean);
    },
    expireCookie(name) {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
      const hostname = window.location.hostname;
      if (hostname) {
        document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${hostname}; SameSite=Lax`;
        document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${hostname}; SameSite=Lax`;
      }
    },
  };
}
