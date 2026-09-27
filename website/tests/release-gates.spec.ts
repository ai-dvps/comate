import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const consentKey = 'comate-analytics-consent';
const releaseUrl = 'https://github.com/ai-dvps/comate/releases';

async function forceMeasurementId(context: BrowserContext, value: string) {
  await context.addInitScript(({ measurementId }) => {
    const observer = new MutationObserver(() => {
      const consent = document.querySelector<HTMLElement>('#analytics-consent');
      if (!consent) return;
      consent.dataset.measurementId = measurementId;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }, { measurementId: value });
}

async function googleRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/google-analytics\.com|googletagmanager\.com/.test(request.url())) requests.push(request.url());
  });
  return requests;
}

for (const locale of ['zh', 'en'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'mobile', width: 390, height: 844 },
    ] as const) {
      test(`${locale} ${theme} ${viewport.name} release matrix`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(({ key, selectedTheme }) => {
          localStorage.setItem(key, JSON.stringify({ version: 1, choice: 'denied' }));
          localStorage.setItem('comate-website-theme', selectedTheme);
        }, { key: consentKey, selectedTheme: theme });
        await page.goto(`/comate/${locale}/`);

        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('[data-product-evidence="home"]')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      });
    }
  }
}

test('no choice shows preferences and makes no Google request', async ({ page }) => {
  const requests = await googleRequests(page);
  await page.goto('/comate/en/');

  await expect(page.locator('#analytics-consent')).toBeVisible();
  await page.waitForTimeout(100);
  expect(requests).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), consentKey)).toBeNull();
});

test('accept then revise to reject persists denial and clears site-owned state', async ({ context, page }) => {
  await forceMeasurementId(context, 'G-TEST123');
  await page.route('https://www.googletagmanager.com/**', (route) => route.fulfill({ body: '' }));
  const requests = await googleRequests(page);
  await page.goto('/comate/en/');

  await page.locator('[data-analytics-choice="accept"]').click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), consentKey)).toContain('granted');
  expect(requests.some((url) => url.includes('googletagmanager.com/gtag/js'))).toBe(true);

  await page.evaluate(() => {
    localStorage.setItem('comate-analytics-temporary', 'remove-me');
    document.cookie = '_ga=test; Path=/; SameSite=Lax';
  });
  await page.locator('[data-analytics-preferences]').first().click();
  await expect(page.locator('#analytics-consent')).toBeVisible();
  await page.locator('[data-analytics-choice="reject"]').click();

  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), consentKey)).toContain('denied');
  expect(await page.evaluate(() => localStorage.getItem('comate-analytics-temporary'))).toBeNull();
  expect(await page.evaluate(() => document.cookie)).not.toContain('_ga=');
});

test('missing Measurement ID remains a consented no-op', async ({ context, page }) => {
  await forceMeasurementId(context, '');
  const requests = await googleRequests(page);
  await page.goto('/comate/en/');
  await page.locator('[data-analytics-choice="accept"]').click();

  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), consentKey)).toContain('granted');
  await page.waitForTimeout(100);
  expect(requests).toEqual([]);
});

test('blocked analytics never blocks the official Releases navigation', async ({ context, page }) => {
  await forceMeasurementId(context, 'G-TEST123');
  await page.route('https://www.googletagmanager.com/**', (route) => route.abort());
  await page.route(releaseUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Releases</title>' }));
  await page.goto('/comate/en/download/');
  await page.locator('[data-analytics-choice="accept"]').click();

  await Promise.all([
    page.waitForURL(releaseUrl),
    page.locator('[data-platform-download="windows"]').click(),
  ]);
  await expect(page).toHaveURL(releaseUrl);
});
