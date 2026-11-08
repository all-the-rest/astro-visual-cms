import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('ambiguous duplicate IDs fail closed in a copied real Astro project', async ({ page, request }) => {
  const sourceFixture = resolve('src/pages/fixture.mdx')
  const original = await readFile(sourceFixture)
  const writes: string[] = []
  page.on('request', (req) => { if (req.method() === 'POST' && /\/api\/mdx-components\/(preview|commit)$/.test(req.url())) writes.push(req.url()) })
  const catalogResponse = await request.get('/api/mdx-components')
  expect(catalogResponse.ok()).toBeTruthy()
  const catalog = await catalogResponse.json()
  expect(catalog.targets).toHaveLength(1)
  expect(catalog.targets[0].supported).toBe(false)
  expect(catalog.targets[0].error || catalog.targets[0].reason).toMatch(/duplicate|ambiguous|identit/i)
  expect(JSON.stringify(catalog)).not.toContain('/avcms-readonly-')

  await page.goto('/')
  await expect(page.locator('#mdx-reason')).toBeVisible()
  await expect(page.locator('#mdx-reason')).toContainText(/duplicate|ambiguous|identit/i)
  await expect(page.locator('#mdx-instance')).toBeDisabled()
  await expect(page.locator('#mdx-instance option')).toHaveCount(0)
  const frame = page.frameLocator('#preview')
  await expect(frame.getByRole('heading', { name: 'Ein Wochenende zwischen Küste und Stadt' })).toBeVisible()
  await expect(frame.getByText('Synthetischer expliziter Auswahlmarker')).toBeVisible()
  await expect(frame.locator('[data-astro-visual-cms-target="fixture"][data-astro-visual-cms-instance="marker-one"]')).toHaveCount(2)
  await frame.locator('[data-astro-visual-cms-target="fixture"][data-astro-visual-cms-instance="marker-one"]').first().click()
  await expect(page.locator('#mdx-instance')).toBeDisabled()
  await expect(page.locator('#mdx-value')).toBeDisabled()
  await expect.poll(() => writes).toEqual([])
  expect(await readFile(sourceFixture)).toEqual(original)
})
