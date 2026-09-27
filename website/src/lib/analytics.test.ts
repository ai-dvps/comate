import { describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_CONSENT_VERSION,
  CONSENT_STORAGE_KEY,
  createAnalytics,
  readConsent,
  type AnalyticsEnvironment,
} from './analytics';

function environment(overrides: Partial<AnalyticsEnvironment> = {}): AnalyticsEnvironment {
  const values = new Map<string, string>();
  return {
    dataLayer: [],
    location: { origin: 'https://example.test', pathname: '/comate/en/download/' },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
    loadTag: vi.fn(),
    expireCookie: vi.fn(),
    cookieNames: () => [],
    ...overrides,
  };
}

describe('analytics consent', () => {
  it('keeps unknown and denied visitors completely offline', () => {
    for (const choice of ['unknown', 'denied'] as const) {
      const env = environment();
      let analytics = createAnalytics('G-TEST123', env);
      if (choice === 'denied') {
        analytics.deny();
        analytics = createAnalytics('G-TEST123', env);
      }

      analytics.bootstrap();
      analytics.trackDownloadCta({
        locale: 'en',
        cta_location: 'nav_primary',
        platform: 'all',
        destination_stage: 'download_page',
      });

      expect(env.loadTag).not.toHaveBeenCalled();
      expect(env.dataLayer).toEqual([]);
    }
  });

  it('initializes once, with defaults before tag loading and ads always denied', () => {
    const order: string[] = [];
    const dataLayer: unknown[][] = [];
    const env = environment({
      dataLayer,
      loadTag: vi.fn(() => order.push('load')),
    });
    const analytics = createAnalytics('G-TEST123', env, (command) => {
      order.push(`${command[0]}:${command[1]}`);
      dataLayer.push(command);
    });

    analytics.grant();
    analytics.bootstrap();

    expect(order.indexOf('consent:default')).toBeLessThan(order.indexOf('load'));
    expect(order.indexOf('consent:update')).toBeLessThan(order.indexOf('load'));
    expect(env.loadTag).toHaveBeenCalledTimes(1);
    const consentCommands = dataLayer.filter((entry) => entry[0] === 'consent');
    expect(consentCommands).toEqual([
      ['consent', 'default', expect.objectContaining({
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      })],
      ['consent', 'update', expect.objectContaining({
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      })],
    ]);
    expect(dataLayer).toContainEqual([
      'config',
      'G-TEST123',
      expect.objectContaining({ send_page_view: false, page_referrer: '', page_location: 'https://example.test/comate/en/download/' }),
    ]);
    expect(dataLayer).toContainEqual([
      'event',
      'page_view',
      expect.objectContaining({ page_referrer: '', page_location: 'https://example.test/comate/en/download/' }),
    ]);
    expect(dataLayer.filter((entry) => entry[0] === 'event' && entry[1] === 'page_view')).toHaveLength(1);
  });

  it('rejects unknown values, keys, and event names', () => {
    const env = environment();
    const analytics = createAnalytics('G-TEST123', env);
    analytics.grant();
    const before = env.dataLayer.length;

    expect(analytics.track('made_up_event', {} as never)).toBe(false);
    expect(analytics.trackDownloadCta({
      locale: 'en',
      cta_location: 'nav_primary',
      platform: 'all',
      destination_stage: 'download_page',
      arbitrary_url: 'https://private.example/query?email=person@example.com',
    } as never)).toBe(false);
    expect(analytics.trackDownloadCta({
      locale: 'fr',
      cta_location: 'nav_primary',
      platform: 'all',
      destination_stage: 'download_page',
    } as never)).toBe(false);
    expect(env.dataLayer).toHaveLength(before);
  });

  it('resets choices written with an older consent version', () => {
    const env = environment();
    env.storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ version: ANALYTICS_CONSENT_VERSION - 1, choice: 'granted' }));

    expect(readConsent(env.storage)).toBe('unknown');
    expect(env.storage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
  });

  it('revokes future measurement and removes known GA cookies and site-owned analytics state', () => {
    const env = environment({ cookieNames: () => ['theme', '_ga', '_ga_TEST123'] });
    env.storage.setItem('comate-analytics-session', 'owned');
    env.storage.setItem('unrelated', 'keep');
    const analytics = createAnalytics('G-TEST123', env);
    analytics.grant();

    analytics.revoke();
    const before = env.dataLayer.length;
    analytics.trackReleaseDownload({
      locale: 'en',
      cta_location: 'download_primary',
      platform: 'macos',
      destination_stage: 'github_releases',
    });

    expect(env.storage.getItem(CONSENT_STORAGE_KEY)).toContain('"choice":"denied"');
    expect(env.storage.getItem('comate-analytics-session')).toBeNull();
    expect(env.storage.getItem('unrelated')).toBe('keep');
    expect(env.expireCookie).toHaveBeenCalledWith('_ga');
    expect(env.expireCookie).toHaveBeenCalledWith('_ga_TEST123');
    expect(env.dataLayer).toHaveLength(before);
  });

  it('keeps denial and revocation safe when browser storage is blocked', () => {
    const blockedStorage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => { throw new Error('storage blocked'); },
      key: () => { throw new Error('storage blocked'); },
      get length(): number { throw new Error('storage blocked'); },
    };
    const analytics = createAnalytics('G-TEST123', environment({ storage: blockedStorage }));

    expect(() => analytics.deny()).not.toThrow();
    analytics.grant();
    expect(() => analytics.revoke()).not.toThrow();
  });

  it('never blocks navigation when dispatch throws or callbacks fail', () => {
    const env = environment();
    const navigate = vi.fn(() => {
      throw new Error('browser navigation simulated');
    });
    const analytics = createAnalytics('G-TEST123', env, () => {
      throw new Error('blocked analytics');
    });
    analytics.grant();

    expect(() => analytics.trackReleaseDownload({
      locale: 'zh',
      cta_location: 'download_secondary',
      platform: 'windows',
      destination_stage: 'github_releases',
    }, navigate)).not.toThrow();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
