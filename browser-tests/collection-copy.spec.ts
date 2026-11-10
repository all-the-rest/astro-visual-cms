import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

test('collection field edits produce revision-bound manual proposals in an isolated project copy', async ({ page, request }) => {
  const rootFixture = resolve('src/pages/fixture.mdx')
  const rootComponent = resolve('src/components/EditorUnknownChip.astro')
  const rootPage = resolve('src/pages/index.astro')
  const rootConfig = resolve('astro.config.mjs')
  const rootFixtureBytes = await readFile(rootFixture)
  const rootComponentBytes = await readFile(rootComponent)
  const rootPageBytes = await readFile(rootPage)
  const rootConfigBytes = await readFile(rootConfig)
  const receiptPath = resolve('test-results/readonly-collection-copy-path')
  await expect.poll(async () => { try { return (await readFile(receiptPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { contentFile: string; configFile: string; pageFile: string }
  const original = await readFile(receipt.contentFile, 'utf8')
  const config = await readFile(receipt.configFile)
  const pageSource = await readFile(receipt.pageFile)
  expect(original).toContain('title: "Synthetic collection entry"')

  const catalogResponse = await request.get('/api/collections')
  expect(catalogResponse.ok()).toBeTruthy()
  const catalog = await catalogResponse.json()
  expect(catalog.configured).toBe(true)
  expect(catalog.collections).toHaveLength(1)
  expect(catalog.collections[0]).toMatchObject({ name: 'notes', supported: true, mode: 'editable' })
  expect(catalog.collections[0].entries.map((entry: { id: string }) => entry.id)).toEqual(['nested/entry.mdx'])
  expect(catalog.collections[0].fields.map((field: { name: string; editable: boolean }) => [field.name, field.editable])).toEqual([['title', true], ['rank', true]])
  expect(JSON.stringify(catalog)).not.toContain('avcms-readonly-')

  const route = 'http://127.0.0.1:15331/browser-synthetic/collection-proof/'
  const initialPage = await request.get(route)
  expect(initialPage.ok()).toBeTruthy()
  const initialHtml = await initialPage.text()
  expect(initialHtml).toMatch(/<h1 data-entry-title(?:\s[^>]*)?>Synthetic collection entry<\/h1>/)
  expect(initialHtml).toContain('Nested synthetic component')

  await page.goto('/')
  const previewNavigation = page.getByRole('navigation', { name: 'Vorschau-Route' })
  const collectionRoute = previewNavigation.getByRole('button', { name: 'Collection proof' })
  await expect(collectionRoute).toBeVisible()
  await expect(collectionRoute).toBeEnabled()
  await expect(collectionRoute).toHaveAttribute('aria-pressed', 'false')
  const fixtureRoute = previewNavigation.getByRole('button', { name: 'Fixture' })
  await expect(fixtureRoute).toBeVisible()
  await expect(fixtureRoute).toHaveAttribute('aria-pressed', 'true')
  await collectionRoute.click()
  await expect(collectionRoute).toHaveAttribute('aria-pressed', 'true')
  await expect(fixtureRoute).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#preview')).toHaveAttribute('title', 'Collection proof-Vorschau')
  await expect(page.frameLocator('#preview').locator('[data-entry-title]')).toHaveText('Synthetic collection entry')
  await expect(page.locator('#collections-panel')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Collection auswählen' }).getByRole('button', { name: 'notes' })).toBeEnabled()
  await expect(page.getByRole('group', { name: 'Eintrag auswählen' }).getByRole('button', { name: 'nested/entry.mdx' })).toBeEnabled()
  const titleInput = () => page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).locator('input')
  const baseline = catalog.collections[0].entries[0].hash as string
  await writeFile(receipt.contentFile, original.replace('rank: 7', 'rank: 8'))
  const cleanRefresh = page.waitForResponse(response => response.url().includes('/api/collections') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await cleanRefresh
  const cleanRevision = (await (await request.get('/api/collections')).json()).collections[0].entries[0].hash as string
  expect(cleanRevision).not.toBe(baseline)
  await titleInput().fill('Clean revision draft')
  await page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.locator('#collection-diff-after')).toContainText('Clean revision draft')
  await page.locator('#cancel-collection-change').click()
  await expect(titleInput()).toHaveValue('Clean revision draft')
  await expect(page.locator('#collection-diff-confirmation')).toBeHidden()

  await titleInput().fill('First local title')
  const beforeExternalPreview = await readFile(receipt.contentFile, 'utf8')
  await writeFile(receipt.contentFile, beforeExternalPreview.replace('rank: 8', 'rank: 9'))
  await expect(page.locator('#collection-conflicts').getByRole('alert')).toBeVisible()
  await expect(page.locator('#collection-conflicts')).toContainText(cleanRevision)
  await expect(page.locator('#collection-conflicts')).toContainText('First local title')
  await expect(page.locator('#collection-conflicts')).toContainText('Aktuelle Revision')
  await expect(page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).getByRole('button', { name: 'Vorschau' })).toBeDisabled()
  expect(await readFile(receipt.contentFile, 'utf8')).toBe(beforeExternalPreview.replace('rank: 8', 'rank: 9'))
  const changedRevision = (await (await request.get('/api/collections')).json()).collections[0].entries[0].hash as string
  expect(changedRevision).not.toBe(cleanRevision)
  await expect(page.locator('#collection-conflicts')).toContainText(changedRevision)
  const reapplyDraft = page.locator('#collection-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })
  await reapplyDraft.focus()
  await expect(reapplyDraft).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#collection-diff-after')).toContainText('First local title')
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#status')).toContainText('Nicht gespeichert')
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  let afterFirst = await readFile(receipt.contentFile, 'utf8')
  expect(afterFirst).toBe(beforeExternalPreview.replace('rank: 8', 'rank: 9'))
  const [fieldDownload] = await Promise.all([
    page.waitForEvent('download'), page.locator('#source-proposal-export').click(),
  ])
  const fieldProposal = JSON.parse(await readFile(await fieldDownload.path(), 'utf8'))
  expect(fieldProposal).toMatchObject({
    type: 'astro-visual-cms-source-proposal',
    target: { kind: 'collection-entry' },
    change: { collectionId: 'notes', field: 'title', value: 'First local title' },
  })
  expect(fieldProposal.target.id).toMatch(/^entry-[0-9a-f-]{36}$/)
  expect(fieldProposal.change).not.toHaveProperty('entryId')
  expect(JSON.stringify(fieldProposal)).not.toContain('nested/entry.mdx')
  expect(fieldProposal.baseHash).toBe(createHash('sha256').update(afterFirst).digest('hex'))
  expect(fieldProposal.proposedHash).toBe(createHash('sha256').update(afterFirst.replace('title: "Synthetic collection entry"', 'title: "First local title"')).digest('hex'))
  expect(fieldProposal.contextHash).toBe(catalog.configHash)
  expect(JSON.stringify(fieldProposal)).not.toContain(receipt.contentFile)
  expect(JSON.stringify(fieldProposal)).not.toContain(afterFirst)

  await titleInput().fill('discard this local value')
  await titleInput().fill('')
  const beforeEmptyDraftConflict = await readFile(receipt.contentFile, 'utf8')
  await writeFile(receipt.contentFile, beforeEmptyDraftConflict.replace('rank: 9', 'rank: 11'))
  await expect(page.locator('#collection-conflicts')).toContainText('Lokaler Entwurf: ""')
  expect(await readFile(receipt.contentFile, 'utf8')).toBe(beforeEmptyDraftConflict.replace('rank: 9', 'rank: 11'))
  await page.locator('#collection-conflicts').getByRole('button', { name: 'Verwerfen und neu laden' }).click()

  await titleInput().fill('Outage draft')
  await page.route('**/api/collections', route => route.abort())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#collection-conflicts')).toContainText('nicht verfügbar')
  await expect(page.locator('#collection-conflicts')).toContainText('Outage draft')
  await expect(page.locator('#collection-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })).toBeDisabled()
  await page.unroute('**/api/collections')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const reconnectedHash = (await (await request.get('/api/collections')).json()).collections[0].entries[0].hash as string
  await expect(page.locator('#collection-conflicts')).toContainText(reconnectedHash)
  await expect(titleInput()).toHaveValue('Outage draft')
  await page.locator('#collection-conflicts').getByRole('button', { name: 'Verwerfen und neu laden' }).click()
  await expect(page.locator('#collection-conflicts')).toBeEmpty()

  const supportedSource = await readFile(receipt.contentFile, 'utf8')
  const invalidSource = supportedSource.replace('rank: 11\n---', 'rank: 11\nrank: 13\n---')
  expect(invalidSource).not.toBe(supportedSource)
  await titleInput().fill('Draft against unsupported source')
  await writeFile(receipt.contentFile, invalidSource)
  await expect(page.locator('#collection-conflicts')).toContainText('Draft against unsupported source')
  const unsupportedReapply = page.locator('#collection-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })
  await unsupportedReapply.click()
  await expect(page.locator('#status')).toContainText('Frontmatter')
  await expect(unsupportedReapply).toBeDisabled()
  expect(await readFile(receipt.contentFile, 'utf8')).toBe(invalidSource)
  await writeFile(receipt.contentFile, supportedSource)
  const recoveredHash = (await (await request.get('/api/collections')).json()).collections[0].entries[0].hash as string
  await expect(page.locator('#collection-conflicts')).toContainText(recoveredHash)
  await expect(page.locator('#collection-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })).toBeEnabled()
  await expect(titleInput()).toHaveValue('Draft against unsupported source')
  await page.locator('#collection-conflicts').getByRole('button', { name: 'Verwerfen und neu laden' }).click()

  await titleInput().fill('Second local title')
  await page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.locator('#collection-diff-after')).toContainText('Second local title')
  const beforeStaleCommit = await readFile(receipt.contentFile, 'utf8')
  await writeFile(receipt.contentFile, beforeStaleCommit.replace('rank: 11', 'rank: 12'))
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#collection-conflicts')).toContainText('Second local title')
  expect(await readFile(receipt.contentFile, 'utf8')).toBe(beforeStaleCommit.replace('rank: 11', 'rank: 12'))
  await page.locator('#collection-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' }).click()
  await expect(page.locator('#collection-diff-after')).toContainText('Second local title')
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#status')).toContainText('Nicht gespeichert')
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  const finalSource = await readFile(receipt.contentFile, 'utf8')
  expect(finalSource).toContain('rank: 12')
  expect(finalSource).toContain('title: "Synthetic collection entry"')
  await expect(collectionRoute).toHaveAttribute('aria-pressed', 'true')
  await expect(page.frameLocator('#preview').locator('[data-entry-title]')).toHaveText('Synthetic collection entry')

  await expect.poll(async () => (await request.get(route)).text()).toMatch(/<h1 data-entry-title(?:\s[^>]*)?>Synthetic collection entry<\/h1>/)
  const rendered = await (await request.get(route)).text()
  expect(rendered).toContain('Nested synthetic component')
  expect(rendered).toMatch(/<p data-entry-rank="\d+"(?:\s[^>]*)?>\d+<\/p>/)

  await page.locator('#collection-conflicts').getByRole('button', { name: 'Verwerfen und neu laden' }).click()
  await titleInput().fill('Write-blocked draft')
  await page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.locator('#collection-diff-after')).toContainText('Write-blocked draft')
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#source-proposal-panel')).toBeVisible()
  await expect(page.locator('#status')).toContainText('Nicht gespeichert')
  await expect(page.locator('#collection-conflicts')).toContainText('Write-blocked draft')
  expect(await readFile(receipt.contentFile, 'utf8')).toBe(finalSource)

  const createForm = page.locator('#create-entry-form')
  const createSlug = createForm.locator('[name="slug"]')
  const createTitle = page.locator('#create-entry-fields [data-field-name="title"]')
  const createRank = page.locator('#create-entry-fields [data-field-name="rank"]')
  const createdFile = (slug: string) => join(dirname(dirname(receipt.contentFile)), `${slug}.mdx`)
  const fileExists = async (file: string) => { try { await readFile(file); return true } catch { return false } }
  expect(catalog.collections[0].creationSupported).toBe(true)
  await createSlug.fill('poll-reapply-note')
  await createTitle.fill('Created after config conflict')
  await createRank.fill('21')
  await createTitle.focus()
  await createTitle.evaluate((input: HTMLInputElement) => input.setSelectionRange(7, 7))
  await createTitle.evaluate((input: HTMLInputElement) => { input.dataset.beforeFocusPoll = 'true' })
  const focusPoll = page.waitForResponse(response => response.url().includes('/api/collections') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await focusPoll
  await expect(createTitle).not.toHaveAttribute('data-before-focus-poll', 'true')
  await expect(createSlug).toHaveValue('poll-reapply-note')
  await expect(createTitle).toHaveValue('Created after config conflict')
  await expect(createRank).toHaveValue('21')
  await expect(createTitle).toBeFocused()
  expect(await createTitle.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(7)

  await page.route('**/api/collections', route => route.abort())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#create-entry-conflicts').getByRole('alert')).toBeVisible()
  await expect(page.locator('#create-entry-conflicts')).toContainText('nicht verfügbar')
  await expect(createTitle).toHaveValue('Created after config conflict')
  await expect(page.locator('#create-entry-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })).toBeDisabled()
  await page.unroute('**/api/collections')
  const reconnectPoll = page.waitForResponse(response => response.url().includes('/api/collections') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await reconnectPoll
  const configHashAfterReconnect = (await (await request.get('/api/collections')).json()).configHash as string
  await expect(page.locator('#create-entry-conflicts')).toContainText(configHashAfterReconnect)
  await expect(page.locator('#create-entry-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })).toBeEnabled()

  const initialConfigHash = catalog.configHash as string
  const configRevisionOne = `${(await readFile(receipt.configFile, 'utf8'))}\n// external config revision before entry preview\n`
  await writeFile(receipt.configFile, configRevisionOne)
  const configPollOne = page.waitForResponse(response => response.url().includes('/api/collections') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await configPollOne
  const latestConfigHashOne = (await (await request.get('/api/collections')).json()).configHash as string
  expect(latestConfigHashOne).not.toBe(initialConfigHash)
  await expect(page.locator('#create-entry-conflicts').getByRole('alert')).toContainText(initialConfigHash)
  await expect(page.locator('#create-entry-conflicts')).toContainText(latestConfigHashOne)
  await expect(page.locator('#create-entry-conflicts')).toContainText('poll-reapply-note')
  await expect(page.locator('#create-entry-conflicts')).toContainText('Created after config conflict')
  await expect(createForm.locator('button[type="submit"]')).toBeDisabled()
  await expect(fileExists(createdFile('poll-reapply-note'))).resolves.toBe(false)
  const reapplyCreateDraft = page.locator('#create-entry-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' })
  await reapplyCreateDraft.focus()
  await expect(reapplyCreateDraft).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#collection-diff-after')).toContainText('Created after config conflict')
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#status')).toContainText('Neuer Eintrag angelegt')
  const createdSource = await readFile(createdFile('poll-reapply-note'), 'utf8')
  expect(createdSource).toContain('Created after config conflict')
  expect(createdSource).toContain('rank: 21')

  await createSlug.fill('stale-create-note')
  await createTitle.fill('Draft survives stale create commit')
  await createRank.fill('22')
  await createForm.locator('button[type="submit"]').click()
  await expect(page.locator('#collection-diff-after')).toContainText('Draft survives stale create commit')
  const configRevisionTwo = `${(await readFile(receipt.configFile, 'utf8'))}\n// external config revision between entry preview and commit\n`
  await writeFile(receipt.configFile, configRevisionTwo)
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#create-entry-conflicts')).toContainText('stale-create-note')
  await expect(page.locator('#create-entry-conflicts')).toContainText('Draft survives stale create commit')
  await expect(fileExists(createdFile('stale-create-note'))).resolves.toBe(false)
  const latestConfigHashTwo = (await (await request.get('/api/collections')).json()).configHash as string
  await expect(page.locator('#create-entry-conflicts')).toContainText(latestConfigHashTwo)
  await page.locator('#create-entry-conflicts').getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' }).click()
  await expect(page.locator('#collection-diff-after')).toContainText('Draft survives stale create commit')
  await page.locator('#confirm-collection-change').click()
  await expect(page.locator('#status')).toContainText('Neuer Eintrag angelegt')
  const staleRecoveredSource = await readFile(createdFile('stale-create-note'), 'utf8')
  expect(staleRecoveredSource).toContain('Draft survives stale create commit')
  expect(staleRecoveredSource).toContain('rank: 22')
  expect(await readFile(receipt.configFile, 'utf8')).toBe(configRevisionTwo)

  await createSlug.fill('discard-create-note')
  await createTitle.fill('Discard this local draft')
  await page.route('**/api/collections', route => route.abort())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#create-entry-conflicts')).toContainText('discard-create-note')
  await page.locator('#create-entry-conflicts').getByRole('button', { name: 'Verwerfen und neu laden' }).click()
  await expect(page.locator('#create-entry-conflicts')).toBeEmpty()
  await expect(createSlug).toHaveValue('')
  await expect(createTitle).toHaveValue('')
  await page.unroute('**/api/collections')

  // Config operations exercise the same stale-config protections without mocking writes.
  const configConflict = page.locator('#config-conflict')
  const configCommit = page.locator('#config-commit')
  const configComment = '// external config revision for config operation\n'
  const appendConfigComment = async () => {
    const before = await readFile(receipt.configFile, 'utf8')
    await writeFile(receipt.configFile, `${before}\n${configComment}`)
    return `${before}\n${configComment}`
  }
  const pollConfigRevision = async () => {
    const poll = page.waitForResponse(response => response.url().includes('/api/collections') && response.request().method() === 'GET')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await poll
  }
  const verifyConfigOperation = async (formSelector: string, values: Record<string, string>, expectedLocalText: string, action: string) => {
    const form = page.locator(formSelector)
    await expect(form).toBeVisible()
    for (const [name, value] of Object.entries(values)) {
      const control = form.locator(`[name="${name}"]`)
      if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(value)
      else await control.fill(value)
    }
    await form.locator('[name="required"]').uncheck()
    const externalBeforePreview = await appendConfigComment()
    await pollConfigRevision()
    await expect(configConflict.getByRole('alert')).toBeVisible()
    await expect(configConflict).toContainText(expectedLocalText)
    await expect(configConflict).toContainText('aktuelle Revision:')
    if (formSelector === '#create-collection-form') await expect(configConflict).not.toContainText('./src/content/acceptance-notes')
    await expect(form.locator('button[type="submit"]')).toBeDisabled()
    await expect(configCommit).toBeDisabled()
    await expect(form.locator('[name="enumValues"]')).toHaveValue('')
    await expect(form.locator('[name="required"]')).not.toBeChecked()
    expect(await readFile(receipt.configFile, 'utf8')).toBe(externalBeforePreview)
    await configConflict.getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' }).click()
    await expect(page.locator('#config-confirmation')).toBeVisible()
    await expect(page.locator('#config-diff')).toContainText(expectedLocalText)
    await expect(configCommit).toBeEnabled()
    const externalAfterPreview = await appendConfigComment()
    await configCommit.click()
    await expect(configConflict.getByRole('alert')).toBeVisible()
    await expect(configConflict).toContainText(expectedLocalText)
    const latest = (await (await request.get('/api/collections')).json()).configHash as string
    await expect.poll(() => configConflict.textContent()).toContain(latest)
    expect(await readFile(receipt.configFile, 'utf8')).toBe(externalAfterPreview)
    await configConflict.getByRole('button', { name: 'Entwurf erneut anwenden und Vorschau erstellen' }).click()
    await expect(page.locator('#config-confirmation')).toBeVisible()
    await expect(page.locator('#config-diff')).toContainText(expectedLocalText)
    await configCommit.click()
    await expect(page.locator('#status')).toContainText('Schreibstatus blockiert')
    await expect(configConflict).toBeHidden()
    const currentConfig = await readFile(receipt.configFile, 'utf8')
    expect(currentConfig).toBe(externalAfterPreview)
    if (action === 'create-collection') {
      await expect(page.locator('#status')).toContainText('relativen Loader-Basispfad')
      await expect(page.locator('#source-proposal-panel')).toBeHidden()
      return await readFile(receipt.configFile)
    }
    await expect(page.locator('#source-proposal-panel')).toBeVisible()
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.locator('#source-proposal-export').click(),
    ])
    const proposal = JSON.parse(await readFile(await download.path(), 'utf8'))
    const expectedSource = currentConfig.slice(0, proposal.diff.start) + proposal.diff.after + currentConfig.slice(proposal.diff.end)
    expect(proposal).toMatchObject({
      type: 'astro-visual-cms-source-proposal',
      target: { kind: 'collection-config', id: 'content-config' },
      baseHash: createHash('sha256').update(currentConfig).digest('hex'),
    })
    expect(proposal.proposedHash).toBe(createHash('sha256').update(expectedSource).digest('hex'))
    expect(proposal.change.action).toBe(action)
    expect(JSON.stringify(proposal)).not.toContain(receipt.configFile)
    expect(JSON.stringify(proposal)).not.toContain(currentConfig)
    return await readFile(receipt.configFile)
  }

  const configAfterCreation = await verifyConfigOperation('#create-collection-form', {
    name: 'browser_copy_notes', base: './src/content/acceptance-notes', pattern: '*.md',
    fieldName: 'label', fieldType: 'string', enumValues: '',
  }, 'browser_copy_notes', 'create-collection')
  const configAfterExtension = await verifyConfigOperation('#extend-field-form', {
    fieldName: 'browser_copy_flag', fieldType: 'boolean', enumValues: '',
  }, 'browser_copy_flag', 'extend-collection')

  expect(configAfterExtension).not.toEqual(config)
  expect(configAfterExtension.toString()).not.toContain('browser_copy_notes')
  expect(configAfterExtension.toString()).not.toContain('browser_copy_flag')
  expect(configAfterCreation.toString()).not.toContain('browser_copy_notes')
  expect(await readFile(receipt.configFile)).toEqual(configAfterExtension)
  expect(await readFile(receipt.pageFile)).toEqual(pageSource)
  expect(await readFile(rootFixture)).toEqual(rootFixtureBytes)
  expect(await readFile(rootComponent)).toEqual(rootComponentBytes)
  expect(await readFile(rootPage)).toEqual(rootPageBytes)
  expect(await readFile(rootConfig)).toEqual(rootConfigBytes)
})

test('collection-entry proposals are not exported after their config revision changes', async ({ page }) => {
  const receiptPath = resolve('test-results/readonly-collection-copy-path')
  await expect.poll(async () => { try { return (await readFile(receiptPath, 'utf8')).length > 0 } catch { return false } }).toBe(true)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { contentFile: string; configFile: string }
  const originalEntry = await readFile(receipt.contentFile, 'utf8')
  const originalConfig = await readFile(receipt.configFile, 'utf8')
  expect(originalEntry).toContain('title: "Synthetic collection entry"')
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window)
    const editorPolls: number[] = []
    ;(window as Window & { stopEditorPolls?: () => void }).stopEditorPolls = () => {
      for (const interval of editorPolls) window.clearInterval(interval)
      editorPolls.length = 0
    }
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const interval = nativeSetInterval(handler, timeout, ...args)
      if (timeout === 2000) editorPolls.push(interval)
      return interval
    }) as typeof window.setInterval
  })

  try {
    await page.goto('/')
    const collectionRoute = page.getByRole('navigation', { name: 'Vorschau-Route' }).getByRole('button', { name: 'Collection proof' })
    await collectionRoute.click()
    await expect(page.locator('#collections-panel')).toBeVisible()
    const titleInput = page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).locator('input')
    await expect(titleInput).toHaveValue('')
    await titleInput.fill('Revision-bound entry draft')
    await page.locator('#collection-fields label').filter({ hasText: 'title (string)' }).getByRole('button', { name: 'Vorschau' }).click()
    await expect(page.locator('#collection-diff-after')).toContainText('Revision-bound entry draft')
    await page.locator('#confirm-collection-change').click()
    await expect(page.locator('#source-proposal-panel')).toBeVisible()
    await expect(page.locator('#source-proposal-export')).toBeEnabled()
    await page.evaluate(() => (window as Window & { stopEditorPolls?: () => void }).stopEditorPolls?.())

    const changedConfig = `${originalConfig}\n// external config revision after entry proposal\n`
    await writeFile(receipt.configFile, changedConfig)
    await page.locator('#source-proposal-export').click()
    await expect(page.locator('#source-proposal-panel')).toBeHidden()
    await expect(page.locator('#status')).toContainText('gebundene Quellrevision ist nicht mehr aktuell')
    await expect(titleInput).toHaveValue('Revision-bound entry draft')
    expect(await readFile(receipt.contentFile, 'utf8')).toBe(originalEntry)
    expect(await readFile(receipt.configFile, 'utf8')).toBe(changedConfig)
    expect(downloads).toBe(0)
  } finally {
    await writeFile(receipt.configFile, originalConfig)
  }
})
