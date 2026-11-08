import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const EDITOR_ORIGIN = 'http://127.0.0.1:15322'

test('in-context selection accepts only a marked supported instance from the current preview frame', async ({ page }) => {
  const fixture = resolve('src/pages/fixture.mdx')
  const original = await readFile(fixture)
  try {
    const writeRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/mdx-components\/(preview|commit)$/.test(request.url())) {
        writeRequests.push(request.url())
      }
    })
    await page.goto('/')
    await expect(page.locator('#mdx-instance')).toHaveValue('unknown-chip')
    await expect(page.locator('#mdx-target')).toHaveValue('fixture')
    await expect(page.locator('#mdx-prop')).toContainText('label')
    const beforeSelection = await readFile(fixture)

    const frame = page.frameLocator('#preview')
    await frame.getByRole('heading', { name: 'Ein Wochenende zwischen Küste und Stadt' }).click()
    await expect(page.locator('#mdx-instance')).toHaveValue('unknown-chip', 'unmarked output must not change the source selection')

    await frame.getByText('Zweiter synthetischer Auswahlmarker').click()
    await expect(page.locator('#mdx-target')).toHaveValue('fixture')
    await expect(page.locator('#mdx-instance')).toHaveValue('marker-two')
    await expect(page.getByRole('status')).toContainText('marker-two ausgewählt')
    expect(await readFile(fixture)).toEqual(beforeSelection)
    expect(writeRequests).toEqual([], 'selection alone must not start a write operation')

    const updated = 'Browser synthetic edit confirmed'
    await page.locator('#mdx-value').fill(updated)
    await page.locator('#mdx-preview-button').click()
    await expect(page.locator('#mdx-diff-before')).toHaveText('"Zweiter synthetischer Auswahlmarker"')
    await expect(page.locator('#mdx-diff-after')).toHaveText(`"${updated}"`)
    expect(await readFile(fixture)).toEqual(beforeSelection)
    await page.locator('#mdx-confirm-button').click()
    await expect(page.getByRole('status')).toContainText('MDX-Änderung gespeichert.')
    await page.locator('#preview').evaluate((frame: HTMLIFrameElement) => {
      frame.src = `${frame.src.split('?')[0]}?after-edit=${Date.now()}`
    })
    const frameAfter = page.frameLocator('#preview')
    await expect(frameAfter.locator('[data-astro-visual-cms-instance="marker-two"]')).toContainText(updated)
    const changed = await readFile(fixture, 'utf8')
    expect(changed).toContain(`<EditorUnknownChip id="marker-two" label="${updated}" />`)
    expect(changed).toBe(beforeSelection.toString('utf8').replace('"Zweiter synthetischer Auswahlmarker"', JSON.stringify(updated)))
    expect(writeRequests).toHaveLength(2)

    await frame.locator('body').evaluate((body) => {
      window.parent.postMessage({
        type: 'avcms:selection',
        nonce: 'not-the-current-preview-nonce',
        targetId: 'fixture',
        instanceId: 'marker-one',
      }, 'http://127.0.0.1:15322')
    })
    await expect(page.locator('#mdx-instance')).toHaveValue('marker-two', 'a stale or forged nonce must be ignored')

    await page.evaluate(() => {
      window.postMessage({
        type: 'avcms:selection',
        nonce: 'not-the-current-preview-nonce',
        targetId: 'fixture',
        instanceId: 'marker-one',
      }, 'http://127.0.0.1:15322')
    })
    await expect(page.locator('#mdx-instance')).toHaveValue('marker-two', 'a message from the editor window must be ignored')
  } finally {
    await writeFile(fixture, original)
  }
})
