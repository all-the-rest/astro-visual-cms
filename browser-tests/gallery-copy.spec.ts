import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('gallery editing is isolated to a disposable Astro copy and exports only a current-revision proposal', async ({ page, request }) => {
  const rootFixture = resolve('src/pages/fixture.mdx')
  const rootComponent = resolve('src/components/EditorUnknownChip.astro')
  const rootBytes = await readFile(rootFixture), componentBytes = await readFile(rootComponent)
  const copiedPath = resolve('test-results/readonly-copy-path')
  await expect.poll(async () => { try { return (await readFile(copiedPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const fixture = await readFile((await readFile(copiedPath, 'utf8')).trim())
  const source = fixture.toString()
  const array = /export const HIGHLIGHTS = (\[[^\]]+\])/.exec(source)
  expect(array).toBeTruthy()
  const old = JSON.parse(array![1]) as string[], next = [...old].reverse()
  const before = await request.get('/api/state'); expect(before.ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByRole('status')).toContainText('Fixture geladen')
  const highlights = page.getByRole('group', { name: 'Galerie auswählen' }).getByRole('button', { name: 'HIGHLIGHTS' })
  await highlights.click()
  const list = page.getByRole('list', { name: 'Reihenfolge der Galerie HIGHLIGHTS' })
  await list.getByRole('listitem').nth(1).dragTo(list.getByRole('listitem').first())
  await expect(page.locator('#diff-confirmation')).toBeVisible()
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  const beforeExternalWrite = await readFile((await readFile(copiedPath, 'utf8')).trim(), 'utf8')
  const externalSource = `${beforeExternalWrite}\n// external receipt-path revision before stale gallery commit\n`
  await writeFile((await readFile(copiedPath, 'utf8')).trim(), externalSource)
  await page.getByRole('button', { name: 'Bestätigen und Änderungsvorschlag erstellen' }).click()
  await expect(page.locator('#gallery-conflict').getByRole('alert')).toBeVisible()
  await expect(page.locator('#gallery-conflict')).toContainText('lokale Reihenfolge')
  await expect(page.locator('#diff-confirmation')).toBeHidden()
  expect(await readFile((await readFile(copiedPath, 'utf8')).trim(), 'utf8')).toBe(externalSource)
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }))
  const reapply = page.locator('#gallery-conflict').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })
  await reapply.click()
  await expect(page.locator('#diff-confirmation')).toBeVisible()
  await expect(page.locator('#diff-after')).toContainText(JSON.stringify(next))
  const externalAfterReapplyPreview = `${await readFile((await readFile(copiedPath, 'utf8')).trim(), 'utf8')}\n// external receipt-path revision before observed gallery commit\n`
  await writeFile((await readFile(copiedPath, 'utf8')).trim(), externalAfterReapplyPreview)
  const galleryPoll = page.waitForResponse(response => response.url().includes('/api/state') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await galleryPoll
  await expect(page.locator('#gallery-conflict').getByRole('alert')).toBeVisible()
  await expect(page.locator('#diff-confirmation')).toBeHidden()
  expect(await readFile((await readFile(copiedPath, 'utf8')).trim(), 'utf8')).toBe(externalAfterReapplyPreview)
  await page.locator('#gallery-conflict').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' }).click()
  await expect(page.locator('#diff-confirmation')).toBeVisible()
  await page.getByRole('button', { name: 'Bestätigen und Änderungsvorschlag erstellen' }).click()
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  const copiedFixturePath = (await readFile(copiedPath, 'utf8')).trim()
  const expected = externalAfterReapplyPreview.replace(array![1], JSON.stringify(next))
  expect(await readFile(copiedFixturePath, 'utf8')).toBe(externalAfterReapplyPreview)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#source-proposal-export').click(),
  ])
  const proposal = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(proposal).toMatchObject({
    schemaVersion: 1,
    type: 'astro-visual-cms-source-proposal',
    target: { kind: 'gallery-fixture', id: 'fixture' },
    baseHash: createHash('sha256').update(externalAfterReapplyPreview).digest('hex'),
    proposedHash: createHash('sha256').update(expected).digest('hex'),
    change: { galleryId: 'HIGHLIGHTS', order: next },
  })
  expect(JSON.stringify(proposal)).not.toContain(copiedFixturePath)
  expect(JSON.stringify(proposal)).not.toContain(externalAfterReapplyPreview)
  const afterCommit = await request.get('/api/state'); expect(afterCommit.ok()).toBeTruthy()
  expect(await readFile(rootFixture)).toEqual(rootBytes); expect(await readFile(rootComponent)).toEqual(componentBytes)
  await page.goto('http://127.0.0.1:15331/browser-synthetic/fixture/')
  await expect(page.locator('[data-nested-unknown]')).toBeVisible()
  await expect(page.locator('section[data-gallery-order]').first()).toHaveAttribute('data-gallery-order', old.join(','))
  const spread = externalAfterReapplyPreview.replace('<Gallery sorted={HIGHLIGHTS} />', '<Gallery {...{ sorted: HIGHLIGHTS }} />')
  await writeFile(copiedFixturePath, spread)
  const state = await request.get('/api/state'); expect(state.status()).toBe(422)
  expect(await state.json()).toMatchObject({ code: 'UNSUPPORTED_DYNAMIC_VALUE' })
  const sessionResponse = await request.get('/api/session'); expect(sessionResponse.ok()).toBeTruthy()
  const { token } = await sessionResponse.json()
  const preview = await request.post('/api/preview', {
    headers: { origin: 'http://127.0.0.1:15332', 'content-type': 'application/json', 'x-editor-token': token },
    data: { galleryId: 'HIGHLIGHTS', order: next, hash: createHash('sha256').update(spread).digest('hex') },
  })
  const previewResult = await preview.json()
  expect({ status: preview.status(), ...previewResult }).toMatchObject({ status: 422, code: 'UNSUPPORTED_DYNAMIC_VALUE' })
  expect(await readFile(copiedFixturePath, 'utf8')).toBe(spread)
  expect(await readFile(rootFixture)).toEqual(rootBytes); expect(await readFile(rootComponent)).toEqual(componentBytes)
})
