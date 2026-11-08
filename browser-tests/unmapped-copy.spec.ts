import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('transformed MDX marker identities stay read-only in a copied real Astro project', async ({ page, request }) => {
  const sourceFixture = resolve('src/pages/fixture.mdx')
  const sourceComponent = resolve('src/components/EditorUnknownChip.astro')
  const original = await readFile(sourceFixture)
  const originalComponent = await readFile(sourceComponent)
  const writes: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/mdx-components\/(preview|commit)$/.test(req.url())) writes.push(req.url())
  })

  const catalogResponse = await request.get('/api/mdx-components')
  expect(catalogResponse.ok()).toBeTruthy()
  const catalog = await catalogResponse.json()
  expect(catalog.targets).toHaveLength(1)
  expect(catalog.targets[0].supported).toBe(true)
  expect(catalog.targets[0].instances.map((instance: { id: string }) => instance.id)).toContain('marker-two')
  expect(JSON.stringify(catalog)).not.toContain('/avcms-readonly-')

  await page.goto('/')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect(page.locator('#mdx-instance')).toHaveValue('unknown-chip')
  const frame = page.frameLocator('#preview')
  await expect(frame.getByRole('heading', { name: 'Ein Wochenende zwischen Küste und Stadt' })).toBeVisible()
  await page.evaluate(() => {
    (window as Window & { __selectionMessages?: unknown[] }).__selectionMessages = []
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'avcms:selection') {
        (window as Window & { __selectionMessages?: unknown[] }).__selectionMessages?.push(event.data)
      }
    })
  })
  const transformed = frame.locator('[data-astro-visual-cms-target="fixture"][data-astro-visual-cms-instance="MARKER-TWO"]')
  await expect(transformed).toHaveCount(1)
  await transformed.click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __selectionMessages?: unknown[] }).__selectionMessages)).toHaveLength(1)
  expect(await page.evaluate(() => (window as Window & { __selectionMessages?: Array<{ instanceId: string }> }).__selectionMessages?.[0]?.instanceId)).toBe('MARKER-TWO')

  await expect(page.locator('#mdx-reason')).toBeVisible()
  await expect(page.locator('#mdx-reason')).toContainText(/keiner eindeutigen Quellinstanz zuordnen|schreibgeschützt/i)
  await expect(page.locator('#status')).toContainText(/schreibgeschützt/i)
  await expect(page.locator('#mdx-instance')).toHaveValue('unknown-chip')
  for (const selector of ['#mdx-target', '#mdx-instance', '#mdx-prop', '#mdx-value', '#mdx-preview-button']) {
    await expect(page.locator(selector)).toBeDisabled()
  }
  expect(writes).toEqual([])
  expect(await readFile(sourceFixture)).toEqual(original)
  expect(await readFile(sourceComponent)).toEqual(originalComponent)
})
