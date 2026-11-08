import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser-tests',
  testMatch: ['gallery.spec.ts', 'in-context-selection.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:15322',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:15322/',
    env: {
      ASTRO_PORT: '15321',
      EDITOR_PORT: '15322',
      ASTRO_BASE_PATH: '/browser-synthetic/',
      AVCMS_BROWSER_SYNTHETIC: '1',
    },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
