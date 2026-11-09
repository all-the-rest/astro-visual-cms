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
