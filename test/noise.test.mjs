import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { FIXTURE_IMAGE_SLUGS } from '../src/lib/gallery-patch.mjs'

test('locally generated fixture images exist, are JPEGs, and contain distinct noise data', async () => {
  const buffers = await Promise.all(FIXTURE_IMAGE_SLUGS.map(async (slug) => {
    const buffer = await readFile(new URL(`../public/images/${slug}.jpg`, import.meta.url))
    assert.equal(buffer[0], 0xff)
    assert.equal(buffer[1], 0xd8)
    assert.equal((await sharp(buffer).metadata()).format, 'jpeg')
    assert.ok(buffer.length > 10_000)
    return buffer
  }))
  assert.equal(new Set(buffers.map((buffer) => buffer.toString('base64'))).size, buffers.length)
})
