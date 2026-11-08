import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const FIXTURE_PATH = fileURLToPath(new URL('../src/pages/fixture.mdx', import.meta.url))

function exportedArray(source: string, name: string): { value: string[]; start: number; end: number } {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\[[^\\]]+\\])`).exec(source)
  if (!match || match.index === undefined) throw new Error(`Could not locate the ${name} fixture array.`)
  const arrayStart = match.index + match[0].lastIndexOf(match[1])
  return {
    value: JSON.parse(match[1]) as string[],
    start: arrayStart,
    end: arrayStart + match[1].length,
  }
}

test('browser editor selects galleries, drag-sorts the Astro preview, and keeps the keyboard-button alternative', async ({ page }) => {
  const originalFixture = await readFile(FIXTURE_PATH)
  const originalSource = originalFixture.toString('utf8')
  const highlights = exportedArray(originalSource, 'HIGHLIGHTS').value
  const details = exportedArray(originalSource, 'DETAILS').value

  try {
    await expect.poll(async () => {
      const response = await page.request.get('http://127.0.0.1:15321/browser-synthetic/fixture/')
      return response.status()
    }).toBe(200)
    const editorResponse = await page.goto('/')
    expect(editorResponse?.status()).toBe(200)
    const policy = editorResponse?.headers()['content-security-policy'] || ''
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain('http://127.0.0.1:15321')
    expect(policy).not.toContain('*')
    const editorHtml = await editorResponse?.text()
    const nonce = editorHtml?.match(/<script nonce="([^"]+)"/)?.[1]
    expect(nonce).toBeTruthy()
    expect(policy).toContain(`'nonce-${nonce}'`)
    await expect(page.getByRole('status')).toHaveText('Fixture geladen. Wähle eine Galerie zum Sortieren.')

    const picker = page.getByRole('group', { name: 'Galerie auswählen' })
    await expect(picker.getByRole('button')).toHaveCount(2)
    await expect(picker.getByRole('button', { name: 'HIGHLIGHTS', exact: true })).toHaveAttribute('aria-pressed', 'true')

    const preview = page.frameLocator('#preview')
    const renderedOrders = async () => {
      try {
        return await preview.locator('section[data-gallery-order]').evaluateAll(
          (sections) => sections.map((section) => section.getAttribute('data-gallery-order')),
        )
      } catch {
        // A fixed-route navigation can replace the iframe execution context between polls.
        return []
      }
    }
    await expect.poll(renderedOrders).toEqual([
      highlights.join(','),
      details.join(','),
    ])

    const renderedViewport = () => preview.locator('body').evaluate(() => [window.innerWidth, window.innerHeight])
    await expect.poll(renderedViewport).toEqual([1280, 800])
    await page.getByRole('group', { name: 'Vorschaugröße' }).getByRole('button', { name: 'Tablet' }).click()
    await expect.poll(renderedViewport).toEqual([768, 1024])
    await page.getByRole('group', { name: 'Vorschaugröße' }).getByRole('button', { name: 'Mobil' }).click()
    await expect.poll(renderedViewport).toEqual([390, 844])
    await page.getByRole('group', { name: 'Vorschaugröße' }).getByRole('button', { name: 'Desktop' }).click()

    const routeNavigation = page.getByRole('navigation', { name: 'Vorschau-Route' })
    await routeNavigation.getByRole('button', { name: 'Startseite' }).click()
    await expect(page.frameLocator('#preview').getByRole('heading', { name: /Astro visual CMS/ })).toBeVisible()
    await routeNavigation.getByRole('button', { name: 'Fixture' }).click()
    await expect.poll(renderedOrders).toEqual([highlights.join(','), details.join(',')])

    const detailsButton = picker.getByRole('button', { name: 'DETAILS', exact: true })
    await detailsButton.focus()
    await detailsButton.press('Enter')
    await expect(detailsButton).toBeFocused()
    await expect(detailsButton).toHaveAttribute('aria-pressed', 'true')
    const list = page.getByRole('list', { name: 'Reihenfolge der Galerie DETAILS' })
    await expect(list.getByRole('listitem')).toHaveCount(details.length)
    await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-label', `DETAILS, Eintrag 1: ${details[0]}`)

    const highlightsButton = picker.getByRole('button', { name: 'HIGHLIGHTS', exact: true })
    await highlightsButton.focus()
    await highlightsButton.press('Enter')
    await expect(highlightsButton).toBeFocused()
    const nextOrder = [...highlights]
    ;[nextOrder[0], nextOrder[1]] = [nextOrder[1], nextOrder[0]]

    const highlightsList = page.getByRole('list', { name: 'Reihenfolge der Galerie HIGHLIGHTS' })
    const originalArray = exportedArray(originalSource, 'HIGHLIGHTS')
    await highlightsList.getByRole('listitem').nth(1).dragTo(highlightsList.getByRole('listitem').first())
    await expect(page.locator('#diff-confirmation')).toBeVisible()
    await expect(page.locator('#diff-before')).toHaveText(originalSource.slice(originalArray.start, originalArray.end))
    await expect(page.locator('#diff-after')).toHaveText(JSON.stringify(nextOrder))
    await expect(page.getByRole('button', { name: 'Änderung bestätigen und speichern' })).toBeVisible()
    await expect.poll(() => readFile(FIXTURE_PATH, 'utf8')).toBe(originalSource)
    await page.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(page.getByRole('status')).toHaveText('Änderung abgebrochen; die Datei blieb unverändert.')
    await expect.poll(() => readFile(FIXTURE_PATH, 'utf8')).toBe(originalSource)

    await highlightsList.getByRole('listitem').nth(1).dragTo(highlightsList.getByRole('listitem').first())
    await expect(page.getByRole('heading', { name: 'Quelländerung bestätigen' })).toBeVisible()
    await page.getByRole('button', { name: 'Änderung bestätigen und speichern' }).click()
    await expect(page.getByRole('status')).toHaveText(/Astro hat alle Galerien mit den aktuellen Reihenfolgen gerendert\./)

    await expect(highlightsList.getByRole('listitem')).toHaveCount(nextOrder.length)
    await expect(highlightsList.getByRole('listitem').first()).toHaveAttribute('aria-label', `HIGHLIGHTS, Eintrag 1: ${nextOrder[0]}`)
    await expect.poll(renderedOrders).toEqual([
      nextOrder.join(','),
      details.join(','),
    ])
    await expect(preview.locator('section[data-gallery-order]').nth(0).locator('figcaption')).toHaveText(
      nextOrder.map((slug, index) => `${index + 1}. ${slug}`),
    )
    await expect(preview.getByText('Unbekannte CMS-Komponente: bleibt außerhalb des Galerie-Editors')).toBeVisible()

    const highlightRange = originalArray
    const expectOnlyHighlightsAndAllPreviewOrders = async (order: string[]) => {
      await expect.poll(renderedOrders).toEqual([
        order.join(','),
        details.join(','),
      ])
      const expectedSource = originalSource.slice(0, highlightRange.start) +
        JSON.stringify(order) + originalSource.slice(highlightRange.end)
      await expect.poll(() => readFile(FIXTURE_PATH, 'utf8')).toBe(expectedSource)
    }
    await expectOnlyHighlightsAndAllPreviewOrders(nextOrder)

    await routeNavigation.getByRole('button', { name: 'Startseite' }).click()
    await expect(page.frameLocator('#preview').getByRole('heading', { name: /Astro visual CMS/ })).toBeVisible()
    await routeNavigation.getByRole('button', { name: 'Fixture' }).click()
    await expect.poll(renderedOrders).toEqual([nextOrder.join(','), details.join(',')])

    const moveDown = page.getByRole('button', { name: `Nach unten: ${nextOrder[0]} in HIGHLIGHTS` })
    await moveDown.focus()
    await moveDown.press('Enter')
    await expect(page.getByRole('heading', { name: 'Quelländerung bestätigen' })).toBeVisible()
    await page.getByRole('button', { name: 'Änderung bestätigen und speichern' }).click()
    await expect(page.getByRole('status')).toHaveText(/Astro hat alle Galerien mit den aktuellen Reihenfolgen gerendert\./)
    await expect(highlightsList.getByRole('listitem').first()).toHaveAttribute('aria-label', `HIGHLIGHTS, Eintrag 1: ${highlights[0]}`)
    await expect(highlightsList.getByRole('listitem').nth(1)).toBeFocused()
    await expect(preview.locator('section[data-gallery-order]').nth(0).locator('figcaption')).toHaveText(
      highlights.map((slug, index) => `${index + 1}. ${slug}`),
    )
    await expectOnlyHighlightsAndAllPreviewOrders(highlights)
  } finally {
    await writeFile(FIXTURE_PATH, originalFixture)
    expect(await readFile(FIXTURE_PATH)).toEqual(originalFixture)
  }
})

test('editor layout has no horizontal overflow in a mobile Chromium context', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:15322/')
    await expect(page.getByRole('status')).toHaveText('Fixture geladen. Wähle eine Galerie zum Sortieren.')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await context.close()
  }
})
