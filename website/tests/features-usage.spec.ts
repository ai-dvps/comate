import { expect, test } from '@playwright/test';

const localeCases = [
  {
    locale: 'zh',
    featureGroups: ['组织工作与上下文', '控制执行与证据', '跟踪进度与自动化', '扩展获批工作流', '桌面连续性与治理'],
    terms: ['Agent 后端', 'Provider', 'Skills', 'MCP', '内嵌浏览器', '定时任务', '企业 IM', 'SkillHub', '企业专区'],
    steps: ['选择平台并安装', '配置并验证模型 Provider', '创建工作区', '创建并起草会话', '运行第一个任务', '处理权限与待关注请求', '复核结果与证据'],
    recovery: ['如果还没有 Provider', '如果凭据或服务地址检查失败', '如果任务需要权限或人工关注'],
  },
  {
    locale: 'en',
    featureGroups: ['Organize work and context', 'Control execution and evidence', 'Track progress and automation', 'Extend approved workflows', 'Desktop continuity and governance'],
    terms: ['Agent backend', 'Provider', 'Skills', 'MCP', 'embedded browser', 'scheduled tasks', 'enterprise IM', 'SkillHub', 'Enterprise Zone'],
    steps: ['Choose your platform and install', 'Configure a model Provider and verify it', 'Create a Workspace', 'Create and draft a Session', 'Run the first task', 'Handle permission and attention requests', 'Review the result and evidence'],
    recovery: ['If no Provider is configured', 'If the credential or endpoint check fails', 'If the task needs permission or attention'],
  },
] as const;

for (const expected of localeCases) {
  test(`${expected.locale} features preserve semantic group order and terminology`, async ({ page }) => {
    await page.goto(`/comate/${expected.locale}/features/`);

    await expect(page.locator('[data-feature-group]')).toHaveCount(expected.featureGroups.length);
    await expect(page.locator('[data-feature-group] > h2')).toHaveText(expected.featureGroups);
    await expect(page.locator('[data-feature-card]')).toHaveCount(10);
    for (const term of expected.terms) {
      await expect(page.getByText(term, { exact: false }).first()).toBeVisible();
    }

    for (const location of ['features_header', 'features_closing']) {
      const cta = page.locator(`a[data-analytics-location="${location}"]`);
      await expect(cta).toHaveAttribute('href', new RegExp(`/comate/${expected.locale}/download/$`));
      await expect(cta).toHaveAttribute('data-analytics-event', 'download_cta_click');
      await expect(cta).toHaveAttribute('data-analytics-locale', expected.locale);
      await expect(cta).toHaveAttribute('data-analytics-platform', 'all');
      await expect(cta).toHaveAttribute('data-analytics-stage', 'download_page');
    }
  });

  test(`${expected.locale} usage puts Provider setup before execution and exposes recovery`, async ({ page }) => {
    await page.goto(`/comate/${expected.locale}/usage/`);

    const steps = page.locator('[data-usage-step]');
    await expect(steps).toHaveCount(7);
    await expect(steps.locator('h2')).toHaveText(expected.steps);
    await expect(page.locator('#provider-setup')).toHaveAttribute('data-usage-step-number', '2');
    expect(await page.locator('#provider-setup').evaluate((node) =>
      Boolean(node.compareDocumentPosition(document.querySelector('[data-usage-step-number="5"]')!) & Node.DOCUMENT_POSITION_FOLLOWING)
    )).toBe(true);

    for (const branch of expected.recovery) {
      await expect(page.getByText(branch, { exact: false })).toBeVisible();
    }

    const cta = page.locator('a[data-analytics-location="usage_closing"]');
    await expect(cta).toHaveAttribute('href', new RegExp(`/comate/${expected.locale}/download/$`));
    await expect(cta).toHaveAttribute('data-analytics-event', 'download_cta_click');
    await expect(cta).toHaveAttribute('data-analytics-locale', expected.locale);
    await expect(cta).toHaveAttribute('data-analytics-platform', 'all');
    await expect(cta).toHaveAttribute('data-analytics-stage', 'download_page');
  });
}
