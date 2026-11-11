import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('MDX block editor adds, edits, reorders, removes, renders, and exports a path-free proposal', async ({ page }) => {
  const file = resolve('src/pages/block-editor-fixture.mdx')
  const original = await readFile(file)
  const blockRequests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/mdx-blocks\/(preview|commit)$/.test(request.url())) blockRequests.push(request.url())
  })

  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  const cards = frame.locator('article[data-block-kind="sample-card"]')
  await expect(cards).toHaveCount(2)

  await page.locator('#mdx-block-add-field-title').fill('Browser-added block')
  await page.locator('#mdx-block-add-field-description').fill('A rendered synthetic draft.')
  await page.getByRole('button', { name: 'Block einfügen und Astro-Vorschau aktualisieren' }).click()
  await expect(cards).toHaveCount(3)
  await expect(frame.getByRole('heading', { name: 'Browser-added block' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()

  await page.getByRole('button', { name: 'Bearbeiten: Inhaltskarte First block' }).click()
  await page.locator('#mdx-block-edit-field-title').fill('Browser-edited block')
  await page.getByRole('button', { name: 'Änderungen in Vorschau übernehmen' }).click()
  await expect(frame.getByRole('heading', { name: 'Browser-edited block' })).toBeVisible()

  await page.getByRole('button', { name: 'Nach unten: Inhaltskarte Browser-edited block' }).click()
  await expect.poll(async () => cards.evaluateAll((items) => items.map((item) => item.id))).toEqual([
    'sample-block-two', 'sample-block-one', expect.stringMatching(/^block-/),
  ])

  await page.getByRole('button', { name: 'Entfernen: Inhaltskarte Second block' }).click()
  await expect(cards).toHaveCount(2)
  await expect(frame.getByRole('heading', { name: 'Second block' })).toHaveCount(0)

  const diskSource = await readFile(file)
  expect(diskSource).toEqual(original)
  await page.locator('#mdx-block-confirm').click()
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  await expect(page.locator('#status')).toContainText('basisgebundene MDX-Blockvorschlag')
  expect(await readFile(file)).toEqual(original)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#source-proposal-export').click(),
  ])
  const proposal = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(proposal).toMatchObject({
    schemaVersion: 1,
    type: 'astro-visual-cms-source-proposal',
    target: { kind: 'mdx-blocks', id: 'block-fixture' },
    change: { operations: expect.any(Array) },
    diffs: expect.any(Array),
  })
  expect(proposal.change.operations.length).toBeGreaterThanOrEqual(4)
  expect(JSON.stringify(proposal)).not.toContain(file)
  expect(JSON.stringify(proposal)).not.toContain(original.toString('utf8'))

  await page.locator('#mdx-block-reset').click()
  await expect(cards).toHaveCount(2)
  await expect(frame.getByRole('heading', { name: 'First block' })).toBeVisible()
  await expect(frame.getByRole('heading', { name: 'Second block' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)
  expect(blockRequests.filter((url) => url.endsWith('/preview'))).toHaveLength(4)
  expect(blockRequests.filter((url) => url.endsWith('/commit'))).toHaveLength(1)
})

test('MDX block form keeps input focus, value, and caret through the two-second poll', async ({ page }) => {
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  const title = page.locator('#mdx-block-add-field-title')
  await title.fill('Typed before poll')
  await expect(title).toBeFocused()
  await page.waitForTimeout(2300)
  await expect(title).toBeFocused()
  await expect(title).toHaveValue('Typed before poll')
  await expect.poll(() => title.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe('Typed before poll'.length)
  await title.pressSequentially(' and after poll')
  await expect(title).toHaveValue('Typed before poll and after poll')
  await expect(title).toBeFocused()
})

test('a failing .mdx Astro render resets the overlay and accepts a later valid preview', async ({ page }) => {
  const file = resolve('src/pages/block-editor-fixture.mdx')
  const original = await readFile(file)
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')

  await page.locator('#mdx-block-add-field-title').fill('Fail Astro render')
  await page.locator('#mdx-block-add-field-description').fill('Synthetic runtime failure.')
  await page.locator('#mdx-block-add').click()
  await expect(page.locator('#mdx-blocks-status')).toContainText('Blockvorschau fehlgeschlagen', { timeout: 45_000 })
  await expect(page.locator('#mdx-blocks-status')).toContainText('vertrauenswürdige Astro-Entwurf wurde zurückgesetzt', { timeout: 45_000 })
  const frame = page.frameLocator('#preview')
  const cards = frame.locator('article[data-block-kind="sample-card"]')
  await expect(cards).toHaveCount(2, { timeout: 30_000 })
  await expect(frame.getByRole('heading', { name: 'First block' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)

  await page.locator('#mdx-block-add-field-title').fill('Recovered preview')
  await page.locator('#mdx-block-add-field-description').fill('Astro remains usable after the reset.')
  await page.locator('#mdx-block-add').click()
  await expect(frame.getByRole('heading', { name: 'Recovered preview' })).toBeVisible({ timeout: 30_000 })
  await expect(cards).toHaveCount(3)
  expect(await readFile(file)).toEqual(original)
})
