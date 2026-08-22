import { expect, test } from '@playwright/test';

const themeStorageKey = 'comate-website-theme';

test('desktop navigation exposes one visible, uniquely labelled language control', async ({ page }) => {
  await page.goto('/comate/zh/');

  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: '立即下载' })).toBeVisible();
  await expect(page.locator('[data-language-picker]:visible')).toHaveCount(1);
  await expect(page.getByLabel('切换语言').filter({ visible: true })).toHaveCount(1);

  const ids = await page.locator('[id]').evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('locale switch preserves the equivalent route', async ({ page }) => {
  await page.goto('/comate/zh/features/');

  await page.locator('[data-language-picker]:visible').selectOption({ label: 'English' });
  await expect(page).toHaveURL(/\/comate\/en\/features\/$/);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('theme state is valid before interaction and persists across reloads', async ({ page }) => {
  await page.addInitScript((key) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, 'not-a-theme');
  }, themeStorageKey);
  await page.goto('/comate/en/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  const initialTheme = await page.locator('html').getAttribute('data-theme');

  await page.getByRole('button', { name: 'Toggle light or dark theme' }).first().click();
  const toggledTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await expect(page.locator('html')).toHaveAttribute('data-theme', toggledTheme);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), themeStorageKey)).toBe(toggledTheme);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', toggledTheme);
});

test('mobile menu manages state, focus, Escape, and touch target size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/comate/en/');

  const toggle = page.locator('#mobile-nav-toggle');
  await expect(toggle).toHaveAccessibleName('Open primary menu');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('navigation', { name: 'Mobile primary navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' }).last()).toBeFocused();

  const box = await toggle.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('the built 404 experience keeps navigation available', async ({ page }) => {
  const response = await page.goto('/comate/a-route-that-does-not-exist/');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回首页|Back to Home/ })).toBeVisible();
});
