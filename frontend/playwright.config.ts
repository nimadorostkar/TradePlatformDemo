import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * SAFETY: these specs run against the built app with EVERY gateway call
 * intercepted (see e2e/fixtures/gateway.ts). No spec may reach a real trading
 * server, and the default command therefore cannot place a trade.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } },
    },
    // Pixel 5 rather than an iPhone profile: it is Chromium-based, so the whole
    // suite runs on the single browser CI installs.
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],

  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
