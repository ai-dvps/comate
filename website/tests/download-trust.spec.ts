import { expect, test, type Browser } from '@playwright/test';

const consentKey = 'comate-analytics-consent';
const releaseUrl = 'https://github.com/ai-dvps/comate/releases';

async function platformState(browser: Browser, userAgent: string) {
  const context = await browser.newContext({ userAgent });
  if (userAgent.startsWith('ComateTrustTest')) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: '' } });
    });
  }
  const page = await context.newPage();
  await page.goto('/comate/en/download/');
  const order = await page.locator('[data-platform-card]').evaluateAll((cards) =>
    cards.map((card) => card.getAttribute('data-platform-card'))
  );
  const recommended = await page.locator('[data-platform-card][data-recommended="true"]').evaluateAll((cards) =>
    cards[0]?.getAttribute('data-platform-card') ?? null
  );
  await context.close();
  return { order, recommended };
}

test('every platform stays visible in stable order while detection only highlights', async ({ browser }) => {
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)', 'macos'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', null],
    ['ComateTrustTest/1.0', null],
  ] as const;

  for (const [userAgent, expected] of cases) {
    const state = await platformState(browser, userAgent);
    expect(state.order).toEqual(['macos', 'windows', 'linux']);
    expect(state.recommended).toBe(expected);
  }
});

test('consented release click emits one allowlisted event and navigates immediately', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, choice: 'granted' }));
    const layer: unknown[][] = [];
    const nativePush = layer.push;
    layer.push = function (...commands: unknown[][]) {
      for (const command of commands) console.log(`COMATE_ANALYTICS:${JSON.stringify(command)}`);
      return nativePush.apply(this, commands);
    };
    (window as typeof window & { dataLayer: unknown[][] }).dataLayer = layer;
    const observer = new MutationObserver(() => {
      const consent = document.querySelector<HTMLElement>('#analytics-consent');
      if (!consent) return;
      consent.dataset.measurementId = 'G-TEST123';
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }, { key: consentKey });
  await context.route('https://www.googletagmanager.com/**', (route) => route.fulfill({ body: '' }));
  await context.route(releaseUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Releases</title>' }));
  const page = await context.newPage();
  const events: unknown[][] = [];
  page.on('console', (message) => {
    if (!message.text().startsWith('COMATE_ANALYTICS:')) return;
    const command = JSON.parse(message.text().slice('COMATE_ANALYTICS:'.length)) as unknown[];
    if (command[0] === 'event') events.push(command);
  });

  await page.goto('/comate/en/download/');
  const download = page.locator('[data-platform-download="linux"]');
  await Promise.all([page.waitForURL(releaseUrl), download.click()]);

  expect(events).toHaveLength(1);
  expect(events[0]?.[1]).toBe('release_download_click');
  expect(events[0]?.[2]).toMatchObject({
    locale: 'en',
    cta_location: 'download_secondary',
    platform: 'linux',
    destination_stage: 'github_releases',
  });
  await context.close();
});

test('denied consent emits no event and never blocks release navigation', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, choice: 'denied' }));
    const layer: unknown[][] = [];
    const nativePush = layer.push;
    layer.push = function (...commands: unknown[][]) {
      for (const command of commands) console.log(`COMATE_ANALYTICS:${JSON.stringify(command)}`);
      return nativePush.apply(this, commands);
    };
    (window as typeof window & { dataLayer: unknown[][] }).dataLayer = layer;
  }, { key: consentKey });
  await context.route(releaseUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Releases</title>' }));
  const page = await context.newPage();
  const events: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('COMATE_ANALYTICS:["event"')) events.push(message.text());
  });
  await page.goto('/comate/zh/download/');
  await Promise.all([page.waitForURL(releaseUrl), page.locator('[data-platform-download="macos"]').click()]);
  expect(events).toEqual([]);
  await context.close();
});

test('Provider disclosure is adjacent and trust answers remain paired with privacy controls', async ({ page }) => {
  await page.goto('/comate/en/download/');
  await expect(page.locator('[data-platform-options] + #provider-prerequisite')).toBeVisible();
  await expect(page.locator('#provider-prerequisite')).toContainText('does not include free inference');
  await expect(page.locator('#provider-prerequisite a')).toHaveAttribute('href', '/comate/en/usage/#provider-setup');

  for (const locale of ['zh', 'en']) {
    await page.goto(`/comate/${locale}/faq/`);
    await expect(page.locator('details')).toHaveCount(10);
    await expect(page.locator('#analytics-privacy')).toBeAttached();
    await expect(page.locator('#change-analytics-preference')).toBeAttached();
    await expect(page.locator('[data-analytics-preferences]')).toBeVisible();
  }

  await page.goto('/comate/en/about/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('real work');
  await expect(page.getByText('programming', { exact: false })).toHaveCount(0);
});
