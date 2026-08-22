import { expect, test } from '@playwright/test';

const locales = [
  {
    locale: 'zh',
    category: '通用 Agent 任务工作区',
    heading: /把复杂工作交给 Agent/,
    workflow: '财务报告任务流程',
    provider: /运行 Agent 并完成任务前，需要提供模型凭据或配置 Provider/,
  },
  {
    locale: 'en',
    category: 'General-purpose Agent task workspace',
    heading: /Give complex work to an Agent/,
    workflow: 'Finance report task flow',
    provider: /running an Agent and completing a task requires model credentials or a configured Provider/,
  },
] as const;

for (const expected of locales) {
  test(`${expected.locale} home communicates category, control, and asynchronous delivery`, async ({ page }) => {
    await page.goto(`/comate/${expected.locale}/`);

    await expect(page.getByText(expected.category, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: expected.heading })).toBeVisible();

    const heroCta = page.locator('a[data-analytics-location="home_hero"]');
    const workflow = page.locator('[data-finance-workflow]');
    await expect(heroCta).toBeVisible();
    await expect(workflow).toBeVisible();
    expect(await heroCta.evaluate((node) => node.compareDocumentPosition(document.querySelector('[data-finance-workflow]')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();

    await expect(page.locator('[data-control-pillar]')).toHaveCount(5);
    await expect(page.getByRole('list', { name: expected.workflow }).locator('[data-finance-stage]')).toHaveCount(7);
    await expect(page.locator('[data-provider-disclosure="home_hero"]')).toContainText(expected.provider);
    await expect(page.locator('[data-provider-disclosure="home_closing"]')).toContainText(expected.provider);

    await expect(heroCta).toHaveAttribute('data-analytics-event', 'download_cta_click');
    await expect(heroCta).toHaveAttribute('data-analytics-locale', expected.locale);
    await expect(heroCta).toHaveAttribute('data-analytics-location', 'home_hero');
    await expect(page.locator('a[data-analytics-location="home_closing"]')).toHaveAttribute('data-analytics-locale', expected.locale);
  });
}

test('home remains readable on mobile and in dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('comate-website-theme', 'light'));
  await page.goto('/comate/en/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[data-finance-workflow]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.locator('#mobile-nav-toggle').click();
  await page.locator('[data-theme-toggle]:visible').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-control-pillars]')).toBeVisible();
});
