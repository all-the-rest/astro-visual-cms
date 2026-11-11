import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser-tests/ui-review',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  outputDir: 'test-results/ui-screenshots',
  use: {
    baseURL: 'http://127.0.0.1:15322',
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:15322',
    env: {
      ASTRO_PORT: '15321',
      EDITOR_PORT: '15322',
      ASTRO_BASE_PATH: '/browser-synthetic/',
      AVCMS_CONFIG: 'playwright.editor.config.json',
    },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
