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
    target: { kind: 'mdx-blocks', id: 'block-fixture', sourceFormat: 'mdx' },
    change: { operations: expect.any(Array) },
    diffs: expect.any(Array),
    application: { mode: 'mdx', rendersAsComponents: true, conversion: 'none' },
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

test('block type selection survives rendering and polling', async ({ page }) => {
  await page.goto('/?route=block-fixture')
  const type = page.locator('#mdx-block-type')
  await expect(type.locator('option')).toHaveCount(2)
  await type.selectOption('sample-callout')
  await expect(type).toHaveValue('sample-callout')
  await page.waitForTimeout(2300)
  await expect(type).toHaveValue('sample-callout')
})

test('inverse edits clear the draft and restore the original preview', async ({ page }) => {
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  await page.getByRole('button', { name: 'Bearbeiten: Inhaltskarte First block' }).click()
  await page.locator('#mdx-block-edit-field-title').fill('Temporary title')
  await page.getByRole('button', { name: 'Änderungen in Vorschau übernehmen' }).click()
  await expect(frame.getByRole('heading', { name: 'Temporary title' })).toBeVisible()
  await page.getByRole('button', { name: 'Bearbeiten: Inhaltskarte Temporary title' }).click()
  await page.locator('#mdx-block-edit-field-title').fill('First block')
  await page.getByRole('button', { name: 'Änderungen in Vorschau übernehmen' }).click()
  await expect(frame.getByRole('heading', { name: 'First block' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeHidden()
  await expect(page.locator('#mdx-block-reset')).toBeDisabled()
})

test('an expired confirmation renews the retained draft instead of leaving it unconfirmable', async ({ page }) => {
  const file = resolve('src/pages/block-editor-fixture.mdx')
  const original = await readFile(file)
  let previewRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mdx-blocks/preview')) previewRequests += 1
  })

  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Expired confirmation draft')
  await page.locator('#mdx-block-add-field-description').fill('Retained across a lost preview token.')
  await page.locator('#mdx-block-add').click()
  await expect(frame.getByRole('heading', { name: 'Expired confirmation draft' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  expect(previewRequests).toBe(1)

  // Simulate the server-side pending preview having elapsed while the overlay and
  // editor draft are still on screen. The client must re-preview, not silently
  // drop the draft and leave a rendered but unconfirmable card behind.
  let interrupted = false
  await page.route('**/api/mdx-blocks/commit', async (route) => {
    if (interrupted) return route.continue()
    interrupted = true
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PREVIEW_EXPIRED', error: 'Block preview expired.' }),
    })
  })

  await page.locator('#mdx-block-confirm').click()
  await expect(page.locator('#status')).toContainText('erneuert')
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  await expect(page.locator('#mdx-block-confirm')).toBeEnabled()
  await expect(frame.getByRole('heading', { name: 'Expired confirmation draft' })).toBeVisible()
  expect(previewRequests).toBeGreaterThanOrEqual(2)
  expect(await readFile(file)).toEqual(original)

  // The renewed preview is a real, fresh confirmation: it now reaches the write
  // policy and produces the manual proposal instead of expiring again.
  await page.locator('#mdx-block-confirm').click()
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  await expect(page.locator('#status')).toContainText('basisgebundene MDX-Blockvorschlag')
  expect(await readFile(file)).toEqual(original)
})

test('an expired confirmation that cannot be renewed is discarded visibly', async ({ page }) => {
  const file = resolve('src/pages/block-editor-fixture.mdx')
  const original = await readFile(file)
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-block-confirmation')).toBeHidden()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Unrecoverable draft')
  await page.locator('#mdx-block-add-field-description').fill('Must be discarded if renewal fails.')
  await page.locator('#mdx-block-add').click()
  await expect(frame.getByRole('heading', { name: 'Unrecoverable draft' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()

  await page.route('**/api/mdx-blocks/commit', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'PREVIEW_EXPIRED', error: 'Block preview expired.' }),
  }))
  await page.route('**/api/mdx-blocks/preview', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'STALE_HASH', error: 'The source changed since this block draft was loaded.' }),
  }))

  await page.locator('#mdx-block-confirm').click()
  await expect(page.locator('#status')).toContainText('Der Entwurf wurde verworfen.')
  await expect(page.locator('#mdx-block-confirmation')).toBeHidden()
  await expect(page.locator('#mdx-block-reset')).toBeDisabled()
  await expect(frame.getByRole('heading', { name: 'Unrecoverable draft' })).toHaveCount(0)
  await expect(frame.getByRole('heading', { name: 'First block' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)
})

test('failed follow-up render preserves the previous successful draft', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Preserved draft')
  await page.locator('#mdx-block-add-field-description').fill('Previously rendered.')
  await page.locator('#mdx-block-add').click()
  await expect(frame.getByRole('heading', { name: 'Preserved draft' })).toBeVisible()
  await page.getByRole('button', { name: 'Bearbeiten: Inhaltskarte First block' }).click()
  await page.locator('#mdx-block-edit-field-title').fill('Fail Astro render')
  await page.getByRole('button', { name: 'Änderungen in Vorschau übernehmen' }).click()
  await expect(page.locator('#mdx-blocks-status')).toContainText('vorherige Entwurf wurde wiederhergestellt', { timeout: 60_000 })
  await expect(frame.getByRole('heading', { name: 'Preserved draft' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  await expect(page.locator('#mdx-block-confirm')).toBeEnabled()
})

test('a .md block preview renders virtually and never renames or writes the Markdown file', async ({ page }) => {
  const file = resolve('src/pages/block-editor-markdown-fixture.md')
  const original = await readFile(file)
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  await page.locator('#mdx-block-target').selectOption('markdown-block-fixture')
  await expect(page.locator('#mdx-block-target')).toHaveValue('markdown-block-fixture')
  await expect(page.locator('#mdx-block-reason')).toContainText('bleibt Markdown')

  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Virtual Markdown block')
  await page.locator('#mdx-block-add-field-description').fill('Rendered through the real .md route.')
  await page.getByRole('button', { name: 'Block einfügen und Astro-Vorschau aktualisieren' }).click()
  await expect(frame.getByRole('heading', { name: 'Virtual Markdown block' })).toBeVisible()
  await expect(frame.getByRole('heading', { name: 'Markdown block fixture' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  expect(await readFile(file)).toEqual(original)
  let siblingExists = true
  try { await readFile(`${file}x`) } catch { siblingExists = false }
  expect(siblingExists).toBe(false)

  await page.locator('#mdx-block-reset').click()
  await expect(frame.getByRole('heading', { name: 'Virtual Markdown block' })).toHaveCount(0)
  await expect(frame.getByRole('heading', { name: 'Markdown block fixture' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)
})

test('an editor reload reclaims a virtual .md overlay instead of rendering the lost draft forever', async ({ page }) => {
  const file = resolve('src/pages/block-editor-markdown-fixture.md')
  const original = await readFile(file)
  await page.goto('/?route=markdown-block-fixture')
  await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
  await page.locator('#mdx-block-target').selectOption('markdown-block-fixture')
  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Overlay lost by reload')
  await page.locator('#mdx-block-add-field-description').fill('Must not survive the editor reload.')
  await page.getByRole('button', { name: 'Block einfügen und Astro-Vorschau aktualisieren' }).click()
  await expect(frame.getByRole('heading', { name: 'Overlay lost by reload' })).toBeVisible()
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  expect(await readFile(file)).toEqual(original)

  await page.reload()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect(frame.getByRole('heading', { name: 'Markdown block fixture' })).toBeVisible({ timeout: 30_000 })
  await expect(frame.getByRole('heading', { name: 'Overlay lost by reload' })).toHaveCount(0)
  await expect(page.locator('#mdx-block-reset')).toBeDisabled()
  expect(await readFile(file)).toEqual(original)
  let siblingExists = true
  try { await readFile(`${file}x`) } catch { siblingExists = false }
  expect(siblingExists).toBe(false)
})

test('a block inserted right after bridge-ready survives the reclaim reload it races', async ({ page }) => {
  const file = resolve('src/pages/block-editor-fixture.mdx')
  const original = await readFile(file)

  // Leave an orphaned overlay behind that only the dev server remembers; the
  // next editor load has no client draft for it and must reclaim it.
  await page.goto('/?route=block-fixture')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const frame = page.frameLocator('#preview')
  await page.locator('#mdx-block-add-field-title').fill('Stale overlay block')
  await page.locator('#mdx-block-add-field-description').fill('Left behind by the previous editor session.')
  await page.locator('#mdx-block-add').click()
  await expect(frame.getByRole('heading', { name: 'Stale overlay block' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)

  // Hold the reclaim's accepted reset so the new insert deterministically lands
  // inside the window before the reload that reset triggers. Without the
  // serialized reclaim the insert's preview starts while the reset is pending,
  // and the reload then rejects it ("Die Vorschau wurde neu geladen."), losing
  // the fresh draft. The gate releases as soon as such a preview races in, and
  // otherwise after a bounded wait.
  let releaseReset = () => {}
  const resetGate = new Promise<void>((release) => { releaseReset = release })
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let resetPending = false
  let previewWhileResetPending = false
  await page.route('**/__avcms/mdx-block-preview', async (route) => {
    const payload = route.request().postDataJSON() as { reset?: boolean } | null
    if (payload?.reset === true) {
      resetPending = true
      releaseTimer = setTimeout(releaseReset, 5_000)
      try {
        await resetGate
      } finally {
        clearTimeout(releaseTimer)
        resetPending = false
      }
      return route.continue()
    }
    if (resetPending) {
      previewWhileResetPending = true
      releaseReset()
    }
    return route.continue()
  })

  await page.reload()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect.poll(() => resetPending).toBe(true)

  await page.locator('#mdx-block-add-field-title').fill('Reclaim-safe block')
  await page.locator('#mdx-block-add-field-description').fill('Must survive the reclaim reload it races.')
  await page.locator('#mdx-block-add').click()

  await expect(frame.getByRole('heading', { name: 'Reclaim-safe block' })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('#mdx-block-confirmation')).toBeVisible()
  await expect(page.locator('#mdx-blocks-status')).not.toContainText('Blockvorschau fehlgeschlagen')
  await expect(frame.getByRole('heading', { name: 'Stale overlay block' })).toHaveCount(0)
  expect(previewWhileResetPending).toBe(false)
  expect(await readFile(file)).toEqual(original)

  await page.locator('#mdx-block-reset').click()
  await expect(frame.getByRole('heading', { name: 'First block' })).toBeVisible()
  await expect(frame.getByRole('heading', { name: 'Second block' })).toBeVisible()
  expect(await readFile(file)).toEqual(original)
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
