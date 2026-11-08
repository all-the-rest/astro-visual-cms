import { expect, test } from '@playwright/test'

const EDITOR_ORIGIN = 'http://127.0.0.1:15322'

test('in-context selection accepts only a marked supported instance from the current preview frame', async ({ page }) => {
  const writeRequests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/mdx-components\/(preview|commit)$/.test(request.url())) {
      writeRequests.push(request.url())
    }
  })
  await page.route(`${EDITOR_ORIGIN}/api/mdx-components`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      configured: true,
      targets: [{
        id: 'fixture',
        hash: 'a'.repeat(64),
        supported: true,
        instances: [
          { id: 'marker-one', props: { title: 'First marker' } },
          { id: 'marker-two', props: { title: 'Second marker' } },
        ],
      }],
    }),
  }))

  await page.goto('/')
  await expect(page.locator('#mdx-instance')).toHaveValue('marker-one')

  const frame = page.frameLocator('#preview')
  await frame.getByRole('heading', { name: 'Ein Wochenende zwischen Küste und Stadt' }).click()
  await expect(page.locator('#mdx-instance')).toHaveValue('marker-one', 'unmarked output must not change the source selection')

  await frame.getByText('Zweiter synthetischer Auswahlmarker').click()
  await expect(page.locator('#mdx-target')).toHaveValue('fixture')
  await expect(page.locator('#mdx-instance')).toHaveValue('marker-two')
  await expect(page.getByRole('status')).toContainText('marker-two ausgewählt')

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
    }, 'http://127.0.0.1:15321')
  })
  await expect(page.locator('#mdx-instance')).toHaveValue('marker-two', 'the editor window is not the preview frame source')
  expect(writeRequests).toEqual([], 'selection alone must not start a write operation')
})
