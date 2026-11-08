import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser-tests', testMatch: '**/readonly-copy.spec.ts', fullyParallel: false, workers: 1,
  retries: 0, reporter: 'list', timeout: 120_000, expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:15332', browserName: 'chromium', headless: true },
  webServer: {
    command: 'node scripts/readonly-browser-server.mjs', url: 'http://127.0.0.1:15332/',
    reuseExistingServer: false, timeout: 120_000, stdout: 'pipe', stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: { AVCMS_READONLY_MODE: 'duplicate' },
  },
})
