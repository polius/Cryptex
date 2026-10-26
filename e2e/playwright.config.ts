import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const DEMO = process.env.DEMO_URL ?? 'http://localhost:8081';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled', caret: 'hide' } },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'UTC',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'flows', testIgnore: /visual|demo/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'demo', testMatch: /demo/, use: { ...devices['Desktop Chrome'], baseURL: DEMO, viewport: { width: 1440, height: 900 } } },
    { name: 'visual', testMatch: /visual/, use: { ...devices['Desktop Chrome'] } },
  ],
});
