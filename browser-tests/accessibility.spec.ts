import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

async function expectEditorAccessible(page: Page, state: string) {
  const results = await new AxeBuilder({ page })
    .exclude('#preview')
    .withTags(WCAG_TAGS)
    .analyze()
  const violations = results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
  }))
  expect(violations, `Accessibility violations in editor state: ${state}`).toEqual([])
}

test('the loaded editor and configured custom-component confirmation meet WCAG 2.2 AA', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(
    () => [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => (link as HTMLLinkElement).sheet !== null),
    undefined,
    { timeout: 30_000 },
  )
  await expect(page.getByRole('status')).toHaveText('Fixture geladen. Wähle eine Galerie zum Sortieren.')
  await expect(page.locator('#mdx-components-panel')).toBeVisible()
  await expect(page.locator('#mdx-value')).toBeEnabled()
  await expect(page.locator('#mdx-value')).toHaveCSS('min-height', '24px')
  await expectEditorAccessible(page, 'desktop editor with configured MDX component')

  await page.setViewportSize({ width: 390, height: 844 })
  await expectEditorAccessible(page, 'mobile editor with configured MDX component')

  await page.locator('#mdx-value').fill('Accessible component edit')
  await page.locator('#mdx-preview-button').click()
  await expect(page.locator('#mdx-confirmation')).toBeVisible()
  await expectEditorAccessible(page, 'mobile custom-component source-diff confirmation')
})

test('configured panels are keyboard reachable and an unconfigured gallery is not an error', async ({ page }) => {
  await page.route('**/api/state', (route) => route.fulfill({ json: { configured: false, galleries: [], hash: '' } }))
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('Keine Galerie zur Bearbeitung konfiguriert.')
  await expect(page.locator('#gallery-instructions')).toBeHidden()
  const link = page.getByRole('link', { name: 'Komponenten', exact: true })
  await expect(link).toBeVisible()
  await link.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#mdx-components-panel')).toBeFocused()
  await expect(page.locator('#mdx-value')).toBeVisible()
  await expectEditorAccessible(page, 'unconfigured gallery and keyboard navigation')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectEditorAccessible(page, 'mobile unconfigured gallery')
})

test('a broken configured gallery remains visible as an error', async ({ page }) => {
  await page.route('**/api/state', (route) => route.fulfill({ status: 422, json: { code: 'UNSUPPORTED_FIXTURE', error: 'broken fixture' } }))
  await page.goto('/')
  await expect(page.locator('#status')).toContainText('Galerie-Fixture (422)')
  await expect(page.getByRole('link', { name: 'Komponenten', exact: true })).toBeVisible()
})

test('a disabled fixture keeps a supported Astro gallery usable and updates availability on polls', async ({ page }) => {
  let astro = {
    configured: true,
    targets: [{
      id: 'astro-gallery', kind: 'astro-internal-gallery', supported: true,
      order: ['noise-fixture-01', 'noise-fixture-02'], hash: 'a'.repeat(64),
    }],
  }
  await page.route('**/api/state', (route) => route.fulfill({ json: { configured: false, galleries: [], hash: '' } }))
  await page.route('**/api/astro-galleries', (route) => route.fulfill({ json: astro }))
  await page.goto('/')

  await expect(page.getByRole('status')).toHaveText('Galerie geladen. Wähle eine Galerie zum Sortieren.')
  await expect(page.locator('#gallery-instructions')).toBeVisible()
  const picker = page.getByRole('group', { name: 'Galerie auswählen' })
  await expect(picker.getByRole('button', { name: 'astro-gallery · Astro', exact: true })).toBeVisible()
  await expect(picker.getByRole('button')).toHaveCount(1)

  astro = {
    configured: true,
    targets: [{ id: 'broken-astro-gallery', kind: 'astro-internal-gallery', supported: false, error: 'Unsupported Astro frontmatter.', code: 'UNSUPPORTED_SYNTAX' }],
  }
  await expect(page.locator('#gallery-instructions')).toBeHidden({ timeout: 6_000 })
  await expect(page.getByRole('status')).toHaveText('Keine unterstützte Galerie zur Bearbeitung konfiguriert.')
  await expect(picker.getByRole('button')).toHaveCount(0)

  astro = {
    configured: true,
    targets: [{
      id: 'astro-gallery', kind: 'astro-internal-gallery', supported: true,
      order: ['noise-fixture-02', 'noise-fixture-01'], hash: 'b'.repeat(64),
    }],
  }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#gallery-instructions')).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Galerie geladen. Wähle eine Galerie zum Sortieren.')
  await expect(picker.getByRole('button', { name: 'astro-gallery · Astro', exact: true })).toBeVisible()
})

test('an unsupported Astro gallery without a fixture is not reported as a loaded fixture', async ({ page }) => {
  await page.route('**/api/state', (route) => route.fulfill({ json: { configured: false, galleries: [], hash: '' } }))
  await page.route('**/api/astro-galleries', (route) => route.fulfill({
    json: {
      configured: true,
      targets: [{ id: 'broken-astro-gallery', kind: 'astro-internal-gallery', supported: false, error: 'Expected Astro frontmatter.', code: 'UNSUPPORTED_TARGET' }],
    },
  }))
  await page.goto('/')

  await expect(page.getByRole('status')).toHaveText('Keine unterstützte Galerie zur Bearbeitung konfiguriert.')
  await expect(page.locator('#gallery-instructions')).toBeHidden()
  await expect(page.getByRole('group', { name: 'Galerie auswählen' }).getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Komponenten', exact: true })).toBeVisible()
  await expectEditorAccessible(page, 'unsupported Astro gallery without a fixture')
})
