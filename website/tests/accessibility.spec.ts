import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const pages = [
  { path: '/comate/zh/', lang: 'zh-CN', navigation: '主导航' },
  { path: '/comate/en/features/', lang: 'en', navigation: 'Primary navigation' },
] as const;

for (const entry of pages) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${entry.lang} ${theme} has accessible shared landmarks and no axe violations`, async ({ page }) => {
      await page.addInitScript(
        ({ value }) => localStorage.setItem('comate-website-theme', value),
        { value: theme },
      );
      await page.goto(entry.path);

      await expect(page.locator('html')).toHaveAttribute('lang', entry.lang);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('navigation', { name: entry.navigation })).toBeVisible();
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('contentinfo')).toBeVisible();

      // Automated scanning is a repeatable guardrail, not a replacement for manual AT review.
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('mobile controls remain labelled and axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/comate/zh/faq/');

  await expect(page.getByRole('button', { name: '打开主菜单' })).toBeVisible();
  await expect(page.getByLabel('切换语言').filter({ visible: true })).toHaveCount(1);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('built CSS retains visible-focus and reduced-motion safeguards', async ({ page, request }) => {
  await page.goto('/comate/en/');
  const stylesheetUrls = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => (link as HTMLLinkElement).href),
  );
  const css = (await Promise.all(stylesheetUrls.map(async (url) => (await request.get(url)).text()))).join('\n');

  expect(css).toContain(':focus-visible');
  expect(css).toContain('prefers-reduced-motion:reduce');

  const themeButton = page.getByRole('button', { name: 'Toggle light or dark theme' }).first();
  await themeButton.focus();
  await expect(themeButton).toBeFocused();
  const focusRing = await themeButton.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusRing).not.toBe('none');
});
