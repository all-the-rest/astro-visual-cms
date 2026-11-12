import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser-tests', testMatch: '**/collection-copy.spec.ts', fullyParallel: false, workers: 1,
  retries: 0, reporter: 'list', timeout: 120_000, expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:15332', browserName: 'chromium', headless: true,
    // Explicit per-action and per-navigation deadlines: without them a stalled UI
    // action or page load consumes the whole 120s test budget and the failure names
    // only the test, which hid the stall that issue #25 needed to diagnose.
    actionTimeout: 15_000, navigationTimeout: 30_000,
    // Retained only for failing tests so CI can upload the trace of the actual stall.
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/readonly-browser-server.mjs', url: 'http://127.0.0.1:15332/',
    reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: { AVCMS_READONLY_MODE: 'collection' },
  },
})
