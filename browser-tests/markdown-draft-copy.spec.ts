import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const targetText = 'This fictional sentence is the one supported visual draft in the sample.'
const targetSelector = '[data-astro-visual-cms-draft-target="showcase-prose"][data-astro-visual-cms-draft-instance="showcase-prose-one"]'
const showcaseUrl = 'http://127.0.0.1:15331/browser-synthetic/reisinger-sample/editorial/showcase/'

test('synthetic Content Layer Markdown draft is isolated, read-only, keyboard accessible, and stale-safe', async ({ page, request }) => {
  const trackedFiles = [
    'src/content/reisinger-like/editorial/showcase/index.mdx',
    'src/content.config.ts',
    'astro.config.mjs',
    'src/editor/astro-integration.mjs',
    'src/editor/sample-dev-config.mjs',
  ]
  const trackedBytes = await Promise.all(trackedFiles.map((file) => readFile(resolve(file))))
  const receiptPath = resolve('test-results/readonly-sample-draft-copy-path')
  await expect.poll(async () => { try { return (await readFile(receiptPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const copiedFile = (await readFile(receiptPath, 'utf8')).trim()
  const initial = await readFile(copiedFile, 'utf8')
  expect(initial.indexOf(targetText)).toBeGreaterThanOrEqual(0)

  const mdxWriteRoutes: string[] = []
  const draftPreviewRoutes: string[] = []
  let downloads = 0
  page.on('request', (browserRequest) => {
    if (browserRequest.method() !== 'POST') return
    if (/\/api\/mdx-components\/(preview|commit)$/.test(browserRequest.url())) mdxWriteRoutes.push(browserRequest.url())
    if (/\/api\/markdown-drafts\/preview$/.test(browserRequest.url())) draftPreviewRoutes.push(browserRequest.url())
  })
  page.on('download', () => { downloads += 1 })

  const catalogResponse = await request.get('/api/markdown-drafts')
  expect(catalogResponse.ok()).toBeTruthy()
  const catalog = await catalogResponse.json()
  expect(catalog).toMatchObject({
    configured: true,
    targets: [{
      id: 'showcase-prose', kind: 'markdown-text-range', supported: true,
      instances: [{ id: 'showcase-prose-one', text: targetText }],
    }],
  })
  expect(JSON.stringify(catalog)).not.toContain(copiedFile)
  expect(JSON.stringify(catalog)).not.toContain(initial)

  const collectionState = await (await request.get('/api/collections')).json()
  expect(collectionState.configured).toBe(true)
  for (const id of ['editorialSample', 'sampleSummary']) {
    const collection = collectionState.collections.find((item: { id: string }) => item.id === id)
    expect(collection).toBeTruthy()
    expect(collection).toMatchObject({ mode: 'read-only', supported: false })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect(page.locator('#markdown-draft-panel')).toBeVisible()
  await expect(page.locator('#collections-panel')).toBeVisible()
  await expect(page.locator('#collection-picker')).toContainText('editorialSample')
  await expect(page.locator('#collection-picker')).toContainText(/read-only|Read-only|schreibgeschützt/i)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const frame = page.frameLocator('#preview')
  const paragraph = frame.locator(targetSelector)
  await expect(paragraph).toHaveText(targetText)
  await paragraph.click()
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()
  await expect(page.locator('#source-proposal-panel')).toBeHidden()
  await expect(page.locator('#source-proposal-export')).toBeHidden()

  // A duplicated rendered identity is explicitly read-only, even if source mapping is unique.
  await paragraph.evaluate((element) => element.after(element.cloneNode(true)))
  await frame.locator(targetSelector).first().click()
  await expect(page.locator('#markdown-draft-status')).toContainText('Mehrere gerenderte Elemente')
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await frame.locator(targetSelector).nth(1).evaluate((element) => element.remove())
  await paragraph.click()
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()

  // A transform that preserves text but wraps it in markup is read-only on selection.
  await paragraph.evaluate((element) => {
    const span = document.createElement('span')
    span.textContent = element.textContent
    element.replaceChildren(span)
  })
  await expect(paragraph).toHaveText(targetText)
  await paragraph.click()
  await expect(page.locator('#markdown-draft-status')).toContainText(/transformiert.*schreibgeschützt/)
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await expect(paragraph.locator('span')).toHaveCount(1)
  await page.locator('#preview').evaluate((element: HTMLIFrameElement) => {
    const url = new URL(element.src)
    url.searchParams.set('draft-reload', String(Date.now()))
    element.src = url.href
  })
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')

  // Rendered text transformed away from the catalogued prose also fails closed.
  const transformedFrame = page.frameLocator('#preview')
  const transformedParagraph = transformedFrame.locator(targetSelector)
  await expect(transformedParagraph).toHaveText(targetText)
  await transformedParagraph.evaluate((element) => { element.textContent = 'Transformed output.' })
  await transformedParagraph.click()
  await expect(page.locator('#markdown-draft-status')).toContainText('verändert oder transformiert')
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await page.locator('#preview').evaluate((element: HTMLIFrameElement) => {
    const url = new URL(element.src)
    url.searchParams.set('draft-reload', String(Date.now()))
    element.src = url.href
  })
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const freshFrame = page.frameLocator('#preview')
  const freshParagraph = freshFrame.locator(targetSelector)
  await expect(freshParagraph).toHaveText(targetText)

  // A wrapper added after selection is checked again before the preview update.
  await freshParagraph.click()
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()
  await freshParagraph.evaluate((element) => {
    const span = document.createElement('span')
    span.textContent = element.textContent
    element.replaceChildren(span)
  })
  const previewRequestsBeforeRejectedUpdate = draftPreviewRoutes.length
  await page.locator('#markdown-draft-apply').click()
  await expect(page.locator('#markdown-draft-status')).toContainText(/transformiert.*schreibgeschützt/)
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await expect(freshParagraph.locator('span')).toHaveCount(1)
  expect(draftPreviewRoutes).toHaveLength(previewRequestsBeforeRejectedUpdate)

  await page.locator('#markdown-draft-reset').click()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const resetAfterRejectedUpdate = page.frameLocator('#preview').locator(targetSelector)
  await expect(resetAfterRejectedUpdate).toHaveText(targetText)
  await expect(resetAfterRejectedUpdate.locator('span')).toHaveCount(0)

  // Keyboard selection through the paragraph's focusable button semantics.
  await resetAfterRejectedUpdate.focus()
  await resetAfterRejectedUpdate.press('Enter')
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()
  await expect(page.locator('#markdown-draft-value')).toBeFocused()

  const unsavedText = 'An unsaved local edit stays in the preview.'
  await page.locator('#markdown-draft-value').fill(unsavedText)
  await expect(resetAfterRejectedUpdate).toHaveText(unsavedText)
  await page.locator('[data-preview-route="showcase"]').click()
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()
  await expect(page.locator('#markdown-draft-value')).toHaveValue(unsavedText)
  await expect(resetAfterRejectedUpdate).toHaveText(unsavedText)

  const updatedText = 'A revised sentence remains a local visual draft.'
  await page.locator('#markdown-draft-value').fill(updatedText)
  await expect(resetAfterRejectedUpdate).toHaveText(updatedText)
  await expect(resetAfterRejectedUpdate.locator('img')).toHaveCount(0)
  await page.locator('#markdown-draft-apply').click()
  await expect(page.locator('#markdown-draft-diff')).toBeVisible()
  await expect(page.locator('#markdown-draft-diff-before')).toHaveText(targetText)
  await expect(page.locator('#markdown-draft-diff-after')).toHaveText(updatedText)
  await expect(page.locator('#markdown-draft-diff-range')).toContainText(`Quelloffset ${initial.indexOf(targetText)}–${initial.indexOf(targetText) + targetText.length}`)
  expect(await readFile(copiedFile, 'utf8')).toBe(initial)
  await expect(page.locator('#source-proposal-panel')).toBeHidden()
  await expect(page.locator('#source-proposal-export')).toBeHidden()
  expect(mdxWriteRoutes).toEqual([])
  expect(draftPreviewRoutes.length).toBeGreaterThan(previewRequestsBeforeRejectedUpdate)
  expect(downloads).toBe(0)

  // An iframe-initiated route change discards the draft/diff; the picker detects
  // the real frame location and can recover the configured Showcase route.
  await resetAfterRejectedUpdate.evaluate(() => window.location.assign('/browser-synthetic/fixture/'))
  const frameBody = page.frameLocator('#preview').locator('body')
  await expect(frameBody).toContainText('Ein Wochenende zwischen Küste und Stadt')
  await expect.poll(() => frameBody.evaluate(() => window.location.pathname)).toBe('/browser-synthetic/fixture/')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect(page.locator('#markdown-draft-diff')).toBeHidden()
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await expect(page.locator('#markdown-draft-status')).toContainText('visuelle Entwurf samt Diff wurde verworfen')

  await page.locator('[data-preview-route="showcase"]').click()
  const recoveredParagraph = page.frameLocator('#preview').locator(targetSelector)
  await expect(recoveredParagraph).toHaveText(targetText)
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  await expect(page.locator('#markdown-draft-diff')).toBeHidden()
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await recoveredParagraph.click()
  await expect(page.locator('#markdown-draft-value')).toBeEnabled()
  await expect(page.locator('#markdown-draft-value')).toHaveValue(targetText)

  // Reset reloads the source-backed Astro page and a no-op remains byte-identical.
  await page.locator('#markdown-draft-reset').click()
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const resetParagraph = page.frameLocator('#preview').locator(targetSelector)
  await expect(resetParagraph).toHaveText(targetText)
  await resetParagraph.click()
  await expect(page.locator('#markdown-draft-value')).toHaveValue(targetText)
  await page.locator('#markdown-draft-apply').click()
  await expect(page.locator('#markdown-draft-status')).toContainText('No-op')
  expect(await readFile(copiedFile, 'utf8')).toBe(initial)

  // An unrelated source revision rejects the old hash; any HMR reload discards
  // the local selection/diff instead of retaining a draft against reset output.
  const actualExternal = initial.replace('Dieser Text ist vollständig synthetisch.', 'Dieser redaktionelle Text ist vollständig synthetisch.')
  expect(actualExternal).not.toBe(initial)
  await writeFile(copiedFile, actualExternal)
  const session = (await (await request.get('/api/session')).json()).token
  const staleResponse = await request.post('/api/markdown-drafts/preview', {
    headers: { origin: 'http://127.0.0.1:15332', 'content-type': 'application/json', 'x-editor-token': session },
    data: { targetId: 'showcase-prose', instanceId: 'showcase-prose-one', value: updatedText, hash: catalog.targets[0].hash },
  })
  expect(staleResponse.status()).toBe(409)
  expect(await staleResponse.json()).toMatchObject({ code: 'STALE_HASH' })
  await expect(page.locator('#markdown-draft-value')).toBeDisabled()
  await expect(page.locator('#markdown-draft-apply')).toBeDisabled()
  await expect(page.locator('#markdown-draft-diff')).toBeHidden()
  expect(await readFile(copiedFile, 'utf8')).toBe(actualExternal)

  // Duplicating the configured source prose removes its marker and catalog support.
  const duplicated = `${actualExternal}\n\n${targetText}\n`
  await writeFile(copiedFile, duplicated)
  const unsupported = await (await request.get('/api/markdown-drafts')).json()
  expect(unsupported.targets[0]).toMatchObject({ id: 'showcase-prose', supported: false, code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
  const duplicatePage = await request.get(`${showcaseUrl}?duplicate=${Date.now()}`)
  expect(await duplicatePage.text()).not.toContain('data-astro-visual-cms-draft-target="showcase-prose"')
  expect(await readFile(copiedFile, 'utf8')).toBe(duplicated)
  expect(mdxWriteRoutes).toEqual([])
  expect(downloads).toBe(0)
  for (let index = 0; index < trackedFiles.length; index++) expect(await readFile(resolve(trackedFiles[index]))).toEqual(trackedBytes[index])
})
