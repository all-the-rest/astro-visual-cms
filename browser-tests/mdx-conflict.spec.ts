import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('configured MDX drafts survive revisions, switching, outages and stale commits in an isolated copy', async ({ page }) => {
  const receiptPath = resolve('test-results/readonly-mdx-conflict-copy-path')
  await expect.poll(async () => { try { return (await readFile(receiptPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const [fileOne, fileTwo] = JSON.parse(await readFile(receiptPath, 'utf8')) as [string, string]
  const originalOne = await readFile(fileOne, 'utf8')
  const updateTwo = async (label: string) => writeFile(fileTwo, (await readFile(fileTwo, 'utf8')).replace(/label="[^"]*"/, `label="${label}"`))
  const updateOne = async (label: string) => writeFile(fileOne, (await readFile(fileOne, 'utf8')).replace(/label="[^"]*"/, `label="${label}"`))
  await page.goto('/')
  const target = page.locator('#mdx-target')
  const prop = page.locator('#mdx-prop')
  const value = page.locator('#mdx-value')
  await expect(target).toBeVisible()
  await expect(value).toHaveValue('Initial 1')

  await updateTwo('Target two clean refresh')
  await target.selectOption({ label: 'two' })
  await expect(value).toHaveValue('Target two clean refresh')
  await expect(page.locator('#mdx-conflict')).toBeHidden()
  await value.fill('Target two retained draft')
  await target.selectOption({ label: 'one' })
  await updateTwo('Target two external conflict')
  const inactiveTargetPoll = page.waitForResponse(response => response.url().includes('/api/mdx-components') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await inactiveTargetPoll
  await target.selectOption({ label: 'two' })
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await expect(value).toHaveValue('Target two retained draft')
  await page.locator('#mdx-conflict-discard').click()
  await expect(value).toHaveValue('Target two external conflict')
  await expect(target).toHaveValue('two')
  await target.selectOption({ label: 'one' })
  await expect(target).toHaveValue('one')
  await expect(page.locator('#mdx-instance')).toHaveValue('conflict-1')
  await expect(value).toHaveValue('Initial 1')

  await updateOne('Clean external refresh')
  await expect(value).toHaveValue('Clean external refresh')

  await value.fill('Preserved dirty draft')
  await updateOne('External revision one')
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await expect(value).toHaveValue('Preserved dirty draft')
  await prop.selectOption({ label: 'title' })
  await expect(value).toHaveValue('Title 1')
  await prop.selectOption({ label: 'label' })
  await expect(value).toHaveValue('Preserved dirty draft')
  await target.selectOption({ label: 'two' })
  await expect(value).toHaveValue('Target two external conflict')
  await value.fill('Target two draft during A conflict')
  await updateTwo('Target two revision during A conflict')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await expect(value).toHaveValue('Target two draft during A conflict')
  await target.selectOption({ label: 'one' })
  await expect(value).toHaveValue('Preserved dirty draft')
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await target.selectOption({ label: 'two' })
  await expect(value).toHaveValue('Target two draft during A conflict')
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await page.locator('#mdx-conflict-discard').click()
  await expect(value).toHaveValue('Target two revision during A conflict')
  await target.selectOption({ label: 'one' })
  await expect(value).toHaveValue('Preserved dirty draft')
  await expect(page.locator('#mdx-conflict')).toBeVisible()

  await updateOne('External revision two')
  await expect(page.locator('#mdx-conflict-message')).toContainText('erneut geändert')
  await expect(value).toHaveValue('Preserved dirty draft')

  await writeFile(fileOne, (await readFile(fileOne, 'utf8')).replace('label="External revision two"', 'label={dynamic}'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict-message')).toContainText('nicht verfügbar')
  await expect(page.locator('#mdx-conflict-reapply')).toBeDisabled()
  await expect(value).toHaveValue('Preserved dirty draft')

  await page.route('**/api/mdx-components', route => route.fulfill({ status: 503, body: 'offline' }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict-message')).toContainText('offline')
  await expect(page.locator('#mdx-conflict-reapply')).toBeDisabled()
  await expect(value).toHaveValue('Preserved dirty draft')
  await page.unroute('**/api/mdx-components')
  await writeFile(fileOne, (await readFile(fileOne, 'utf8')).replace('label={dynamic}', 'label="External revision two"'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict-reapply')).toBeEnabled()

  await page.locator('#mdx-conflict-reapply').click()
  await expect(page.locator('#mdx-confirmation')).toBeVisible()
  await expect(page.locator('#mdx-diff-before')).toHaveText('"External revision two"')
  await expect(page.locator('#mdx-diff-after')).toHaveText('"Preserved dirty draft"')
  await page.locator('#mdx-confirm-button').click()
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await expect(page.locator('#mdx-conflict-message')).toContainText('standardmäßig blockiert')
  await expect(page.locator('#mdx-proposal-export')).toBeVisible()
  await expect(value).toHaveValue('Preserved dirty draft')
  const sourceAtExport = await readFile(fileOne, 'utf8')
  expect(sourceAtExport).toContain('External revision two')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#mdx-proposal-export').click(),
  ])
  const proposal = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(proposal).toEqual({
    schemaVersion: 1,
    type: 'astro-visual-cms-mdx-proposal',
    targetId: 'one',
    instanceId: 'conflict-1',
    prop: 'label',
    baseHash: createHash('sha256').update(sourceAtExport).digest('hex'),
    proposedHash: createHash('sha256').update(sourceAtExport.replace('label="External revision two"', 'label="Preserved dirty draft"')).digest('hex'),
    diff: {
      start: sourceAtExport.indexOf('"External revision two"'),
      end: sourceAtExport.indexOf('"External revision two"') + '"External revision two"'.length,
      before: '"External revision two"',
      after: '"Preserved dirty draft"',
    },
  })
  expect(JSON.stringify(proposal)).not.toContain(fileOne)
  expect(JSON.stringify(proposal)).not.toContain(sourceAtExport)

  await updateOne('External revision three')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await expect(page.locator('#mdx-proposal-export')).toBeHidden()
  await expect(value).toHaveValue('Preserved dirty draft')

  await page.locator('#mdx-conflict-reapply').click()
  await expect(page.locator('#mdx-confirmation')).toBeVisible()
  await expect(page.locator('#mdx-diff-before')).toHaveText('"External revision three"')
  await page.locator('#mdx-cancel-button').click()
  await updateOne('External revision four')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#mdx-conflict')).toBeVisible()
  await page.locator('#mdx-conflict-discard').click()
  await expect(page.locator('#mdx-conflict')).toBeHidden()
  await expect(value).toHaveValue('External revision four')

  await value.fill('Preview lock draft')
  await page.locator('#mdx-preview-button').click()
  await expect(page.locator('#mdx-confirmation')).toBeVisible()
  await expect(value).toBeDisabled()
  await expect(target).toBeDisabled()
  await expect(prop).toBeDisabled()
  await page.locator('#mdx-cancel-button').click()
  await expect(value).toBeEnabled()
  await expect(value).toHaveValue('Preview lock draft')
  expect(await readFile(fileTwo, 'utf8')).toContain('Target two revision during A conflict')
  expect(originalOne).toContain('Initial 1')
})
