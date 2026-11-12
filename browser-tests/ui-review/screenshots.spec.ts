import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { uiReviewConfig } from './manifest'

const sectionLimit = 8

for (const route of uiReviewConfig.routes) {
  for (const state of route.states) {
    for (const viewport of route.viewports) {
      test(`screenshot ${route.name} (${state}, ${viewport})`, { tag: ['@screenshot'] }, async ({ page }) => {
        const size = page.viewportSize()
        const expectedSize = uiReviewConfig.viewportSizes[viewport]
        test.skip(!size || size.width !== expectedSize.width || size.height !== expectedSize.height,
          `The ${viewport} project must use ${expectedSize.width}x${expectedSize.height}.`)

        await page.goto(route.path)
        await expect(page).toHaveTitle(route.expectedTitle)
        await expect(page.getByRole('main')).toBeVisible()
        if (route.name === 'mdx-block-editor') {
          await expect(page.locator('#mdx-blocks-panel')).toBeVisible()
          await expect(page.locator('#preview')).toHaveAttribute('data-bridge-ready', 'true')
          if (viewport === 'mobile') {
            const status = page.locator('#mdx-blocks-status')
            await expect.poll(() => status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
          }
        }
        await page.waitForLoadState('networkidle')

        await page.evaluate(() => { if (document.scrollingElement) document.scrollingElement.scrollTop = 0 })
        await page.waitForTimeout(200)
        const scroll = await page.evaluate(() => ({
          height: window.innerHeight,
          max: Math.max(0, (document.scrollingElement?.scrollHeight || window.innerHeight) - window.innerHeight),
        }))
        const step = Math.max(1, Math.round(scroll.height * 0.8))
        const offsets = [0]
        while (offsets[offsets.length - 1] < scroll.max) offsets.push(Math.min(scroll.max, offsets.at(-1)! + step))
        const indexes = offsets.length <= sectionLimit
          ? offsets.map((_offset, index) => index)
          : [...new Set([
            ...Array.from({ length: Math.min(4, offsets.length) }, (_value, index) => index),
            ...Array.from({ length: Math.min(2, offsets.length) }, (_value, index) => offsets.length - Math.min(2, offsets.length) + index),
          ])].sort((a, b) => a - b)
        const output = path.resolve(process.cwd(), uiReviewConfig.outputDir, state, viewport)
        await mkdir(output, { recursive: true })
        for (const index of indexes) {
          await page.evaluate((y) => { if (document.scrollingElement) document.scrollingElement.scrollTop = y }, offsets[index])
          await page.waitForTimeout(150)
          await page.screenshot({ path: path.join(output, `${route.name}-sec${index}.png`) })
        }
        if (offsets.length <= sectionLimit) {
          await page.screenshot({ path: path.join(output, `${route.name}.png`), fullPage: true })
        }
        const coverage = {
          route: route.name,
          state,
          viewport,
          viewportSize: size,
          sections: offsets.length,
          capturedSectionIndexes: indexes,
          capturedSections: indexes.map((index) => ({ index, scrollY: offsets[index] })),
          footerReady: false,
          footerSectionIndex: null,
          fullPageOverview: offsets.length <= sectionLimit,
          note: route.note,
        }
        await writeFile(path.join(output, `${route.name}.json`), `${JSON.stringify(coverage, null, 2)}\n`)
      })
    }
  }
}
