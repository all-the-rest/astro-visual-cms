import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('a dev-only source-mapped Markdown paragraph exports a revision-bound proposal in an isolated Astro copy', async ({ page, request }) => {
  const trackedFiles = ['src/pages/fixture.mdx', 'src/components/EditorUnknownChip.astro', 'astro.config.mjs']
  const trackedBytes = await Promise.all(trackedFiles.map((file) => readFile(resolve(file))))
  const receiptPath = resolve('test-results/readonly-markdown-copy-path')
  await expect.poll(async () => { try { return (await readFile(receiptPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const copiedFile = (await readFile(receiptPath, 'utf8')).trim()
  const initial = await readFile(copiedFile, 'utf8')
  const expected = initial.replace('Synthetic mapped Markdown paragraph.', 'Updated mapped Markdown paragraph.')
  expect(expected).not.toBe(initial)
  await page.addInitScript(() => {
    const w = window as Window & { __avcmsSelections?: unknown[] }
    w.__avcmsSelections = []
    addEventListener('message', (event) => {
      if (event.data?.type === 'avcms:selection') w.__avcmsSelections?.push(event.data)
    })
  })
  const operations: string[] = []
  page.on('request', (browserRequest) => {
    if (browserRequest.method() === 'POST' && /\/api\/mdx-components\/(preview|commit)$/.test(browserRequest.url())) operations.push(browserRequest.url())
  })
  const catalogResponse = await request.get('/api/mdx-components')
  expect(catalogResponse.ok()).toBeTruthy()
  const catalog = await catalogResponse.json()
  expect(catalog).toMatchObject({ configured: true, targets: [{ id: 'markdown-note', kind: 'markdown-paragraph', supported: true, instances: [{ id: 'paragraph-one', props: { text: 'Synthetic mapped Markdown paragraph.' } }] }] })
  expect(JSON.stringify(catalog)).not.toContain('/tmp/')

  await page.goto('/')
  await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
  const preview = page.locator('#preview')
  await preview.evaluate((frame: HTMLIFrameElement) => { frame.src = 'http://127.0.0.1:15331/browser-synthetic/markdown-proof/' })
  const initialRender = await request.get('http://127.0.0.1:15331/browser-synthetic/markdown-proof/')
  expect(initialRender.ok()).toBeTruthy()
  const initialHtml = await initialRender.text()
  expect(initialHtml).toContain('Synthetic mapped Markdown paragraph.')
  expect(initialHtml).toContain('data-astro-visual-cms-target="markdown-note"')
  const frame = page.frameLocator('#preview')
  const markedParagraph = frame.locator('[data-astro-visual-cms-target="markdown-note"][data-astro-visual-cms-instance="paragraph-one"]')
  await expect(markedParagraph).toHaveText('Synthetic mapped Markdown paragraph.')
  await frame.getByText('Synthetic mapped Markdown paragraph.').click()
  await expect(page.locator('#mdx-target')).toHaveValue('markdown-note')
  await expect(page.locator('#mdx-instance')).toHaveValue('paragraph-one')
  await expect(page.locator('#mdx-panel-title')).toHaveText('Markdown-Absatz')
  await expect.poll(() => page.evaluate(() => (window as Window & { __avcmsSelections?: unknown[] }).__avcmsSelections?.length)).toBe(1)
  expect(operations).toEqual([])
  expect(await readFile(copiedFile, 'utf8')).toBe(initial)

  await page.locator('#mdx-value').fill('Updated mapped Markdown paragraph.')
  await page.locator('#mdx-preview-button').click()
  await expect(page.locator('#mdx-diff-before')).toHaveText('Synthetic mapped Markdown paragraph.')
  await expect(page.locator('#mdx-diff-after')).toHaveText('Updated mapped Markdown paragraph.')
  expect(await readFile(copiedFile, 'utf8')).toBe(initial)
  await page.locator('#mdx-confirm-button').click()
  await expect(page.locator('#status')).toContainText('Nicht gespeichert')
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  expect(await readFile(copiedFile, 'utf8')).toBe(initial)
  expect(operations).toHaveLength(2)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#source-proposal-export').click(),
  ])
  const proposal = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(proposal).toMatchObject({
    schemaVersion: 1,
    type: 'astro-visual-cms-source-proposal',
    target: { kind: 'mdx-target', id: 'markdown-note' },
    baseHash: createHash('sha256').update(initial).digest('hex'),
    proposedHash: createHash('sha256').update(expected).digest('hex'),
    change: { instanceId: 'paragraph-one', prop: 'text', value: 'Updated mapped Markdown paragraph.' },
    diff: { before: 'Synthetic mapped Markdown paragraph.', after: 'Updated mapped Markdown paragraph.' },
  })
  expect(JSON.stringify(proposal)).not.toContain(copiedFile)
  expect(JSON.stringify(proposal)).not.toContain(initial)

  await preview.evaluate((frame: HTMLIFrameElement) => { frame.src = `http://127.0.0.1:15331/browser-synthetic/markdown-proof/?revision=${Date.now()}` })
  const rerendered = page.frameLocator('#preview')
  await expect(rerendered.locator('[data-astro-visual-cms-target="markdown-note"]')).toHaveText('Synthetic mapped Markdown paragraph.')
  const renderedResponse = await request.get('http://127.0.0.1:15331/browser-synthetic/markdown-proof/')
  expect(await renderedResponse.text()).toContain('Synthetic mapped Markdown paragraph.')

  const duplicate = `${initial}\n\nA second paragraph makes this mapping ambiguous.\n`
  await writeFile(copiedFile, duplicate)
  const unsupported = await (await request.get('/api/mdx-components')).json()
  expect(unsupported.targets[0]).toMatchObject({ id: 'markdown-note', supported: false })
  await expect.poll(async () => {
    const ambiguousPage = await request.get('http://127.0.0.1:15331/browser-synthetic/markdown-proof/')
    if (!ambiguousPage.ok()) throw new Error(`Expected the duplicate route to render, got HTTP ${ambiguousPage.status()}.`)
    return (await ambiguousPage.text()).includes('data-astro-visual-cms-target="markdown-note"')
  }, { timeout: 15_000, intervals: [100, 250, 500, 1000] }).toBe(false)
  const session = await (await request.get('/api/session')).json()
  const rejected = await request.post('/api/mdx-components/preview', {
    headers: { origin: 'http://127.0.0.1:15332', 'content-type': 'application/json', 'x-editor-token': session.token },
    data: { targetId: 'markdown-note', instanceId: 'paragraph-one', prop: 'text', value: 'Should not save.', hash: createHash('sha256').update(duplicate).digest('hex') },
  })
  expect(rejected.status()).toBe(422)
  expect(await rejected.json()).toMatchObject({ code: 'UNSUPPORTED_MARKDOWN_MAPPING' })
  expect(await readFile(copiedFile, 'utf8')).toBe(duplicate)
  for (let index = 0; index < trackedFiles.length; index++) expect(await readFile(resolve(trackedFiles[index]))).toEqual(trackedBytes[index])
})
