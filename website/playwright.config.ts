import { defineConfig, devices } from '@playwright/test';

const port = 4321;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/comate`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // The verification contract builds once before this command so the browser
    // suite exercises the same static output that is uploaded to GitHub Pages.
    command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/comate/zh/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
