import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import test from 'node:test'
import { FIXTURE_IMAGE_SLUGS } from '../src/lib/gallery-patch.mjs'
import { resolveFixtureImageMetadata } from '../src/lib/image-slug-resolver.mjs'

test('the fixture slug resolver returns Astro image metadata without a Vite image import', async () => {
  const image = await resolveFixtureImageMetadata(FIXTURE_IMAGE_SLUGS[0])
  assert.match(image.src, /^\/images\/noise-fixture-01\.jpg\?content=[a-f0-9]{64}$/)
  assert.equal(image.width, 640)
  assert.equal(image.height, 400)
  assert.equal(image.format, 'jpeg')
  assert.ok(Object.getOwnPropertyDescriptor(image, 'fsPath')?.enumerable === false)
  await access(image.fsPath)
  assert.equal(Object.keys(image).includes('fsPath'), false)
  await assert.rejects(() => resolveFixtureImageMetadata('../outside'), /Unknown fixture image slug/)
})
