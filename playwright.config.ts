import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3100/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: '3100',
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ontheloop_test',
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      CTA_MOCK: process.env.CTA_MOCK || '1',
      GEMINI_MOCK: process.env.GEMINI_MOCK || '1',
      RUN_WORKER_IN_PROCESS: process.env.RUN_WORKER_IN_PROCESS || 'false',
    },
  },
});
