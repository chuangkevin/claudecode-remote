import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 200_000,       // 3+ min per test (AI responses are slow)
  expect: { timeout: 30_000 },
  fullyParallel: false,   // serial: tests share session state
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: 'http://localhost:9224',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
