import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { createSourceJpegImportGuard, generateStaticVariants, validateStaticImageManifest } from '../scripts/sharp-static-variants.mjs'

const baseEntry = Object.freeze({
  slug: 'test-image',
  file: 'test-image.jpg',
  format: 'jpeg',
  maxBytes: 1_000_000,
  maxPixels: 100_000,
  widths: [8, 16],
})

async function withTemporaryRoot(callback) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'sharp-static-variants-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function fixtureJpeg() {
  const pixels = Buffer.alloc(32 * 16 * 3)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31 + 17) % 256
  return sharp(pixels, { raw: { width: 32, height: 16, channels: 3 } }).jpeg({ quality: 88 }).toBuffer()
}

async function setupImageRoot(root, file = baseEntry.file, bytes = undefined) {
  const imageRoot = path.join(root, 'input')
  const publicRoot = path.join(root, 'public')
  await mkdir(imageRoot)
  await mkdir(publicRoot)
  const sourceBytes = bytes ?? await fixtureJpeg()
  if (file) await writeFile(path.join(imageRoot, file), sourceBytes)
  return { imageRoot, publicRoot, bytes: sourceBytes }
}

test('the technical source manifest rejects duplicate names, traversal, unsupported formats and unsafe limits', () => {
  assert.throws(() => validateStaticImageManifest([]), { code: 'INVALID_IMAGE_MANIFEST' })
  assert.throws(() => validateStaticImageManifest([baseEntry, { ...baseEntry, file: 'other.jpg' }]), {
    code: 'DUPLICATE_IMAGE_SLUG',
  })
  assert.throws(() => validateStaticImageManifest([baseEntry, { ...baseEntry, slug: 'other-image' }]), {
    code: 'DUPLICATE_IMAGE_FILE',
  })
  for (const file of ['../outside.jpg', '..\\outside.jpg', '/outside.jpg', 'C:\\outside.jpg']) {
    assert.throws(() => validateStaticImageManifest([{ ...baseEntry, file }]), { code: 'INVALID_IMAGE_MANIFEST' })
  }
  for (const manifest of [
    [{ ...baseEntry, format: 'png' }],
    [{ ...baseEntry, file: 'test-image.avif', format: 'avif' }],
    [{ ...baseEntry, maxBytes: 5 * 1024 * 1024 + 1 }],
    [{ ...baseEntry, maxPixels: 10_000_001 }],
    [{ ...baseEntry, widths: [8, 8] }],
    [{ ...baseEntry, widths: [40_000] }],
    [{ ...baseEntry, alt: 'metadata is outside the shared pipeline' }],
  ]) {
    assert.throws(() => validateStaticImageManifest(manifest), { code: 'INVALID_IMAGE_MANIFEST' })
  }
})

test('Sharp emits only technical, deterministic WebP variant metadata', async () => {
  await withTemporaryRoot(async (root) => {
    const { imageRoot, publicRoot } = await setupImageRoot(root)
    const first = await generateStaticVariants({ manifest: [baseEntry], imageRoot, publicRoot })
    const repeated = await generateStaticVariants({ manifest: [baseEntry], imageRoot, publicRoot })
    assert.deepEqual(repeated, first)
    assert.deepEqual(Object.keys(first.images[0]).sort(), ['height', 'slug', 'variants', 'width'])
    assert.deepEqual(first.images[0].variants.map(({ width, height }) => [width, height]), [[8, 4], [16, 8]])
    assert.ok(first.images[0].variants.every(({ url }) => /^\/variants\/test-image-[a-f0-9]{64}-\d+\.webp$/.test(url)))
    assert.ok(!JSON.stringify(first).match(/alt|description|exif|sourcePath|\.jpg/i))
  })
})

test('source validation fails closed for unavailable, non-file, oversized, over-pixel, and non-JPEG inputs', async () => {
  await withTemporaryRoot(async (root) => {
    const validBytes = await fixtureJpeg()
    const { imageRoot, publicRoot } = await setupImageRoot(root, 'valid.jpg', validBytes)
    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'missing.jpg' }], imageRoot, publicRoot,
    }), { code: 'IMAGE_SOURCE_UNAVAILABLE' })

    await mkdir(path.join(imageRoot, 'directory.jpg'))
    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'directory.jpg' }], imageRoot, publicRoot,
    }), { code: 'IMAGE_SOURCE_NOT_FILE' })

    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'valid.jpg', maxBytes: validBytes.byteLength - 1 }], imageRoot, publicRoot,
    }), { code: 'IMAGE_SOURCE_TOO_LARGE' })

    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'valid.jpg', maxPixels: 100 }], imageRoot, publicRoot,
    }), { code: 'IMAGE_DIMENSIONS_TOO_LARGE' })

    const pngBytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#123456' } }).png().toBuffer()
    await writeFile(path.join(imageRoot, 'not-jpeg.jpg'), pngBytes)
    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'not-jpeg.jpg' }], imageRoot, publicRoot,
    }), { code: 'IMAGE_FORMAT_MISMATCH' })

    await writeFile(path.join(imageRoot, 'invalid.jpg'), Buffer.from('not an image'))
    await assert.rejects(() => generateStaticVariants({
      manifest: [{ ...baseEntry, file: 'invalid.jpg' }], imageRoot, publicRoot,
    }), { code: 'INVALID_IMAGE' })
  })
})

test('source roots, their ancestors, and source files reject symlinks', async () => {
  await withTemporaryRoot(async (root) => {
    const bytes = await fixtureJpeg()
    const realInput = path.join(root, 'real-input')
    const publicRoot = path.join(root, 'public')
    await mkdir(realInput)
    await mkdir(publicRoot)
    await writeFile(path.join(realInput, baseEntry.file), bytes)

    const linkedFileRoot = path.join(root, 'linked-file-root')
    await mkdir(linkedFileRoot)
    await symlink(path.join(realInput, baseEntry.file), path.join(linkedFileRoot, baseEntry.file))
    await assert.rejects(
      () => generateStaticVariants({ manifest: [baseEntry], imageRoot: linkedFileRoot, publicRoot }),
      { code: 'IMAGE_SOURCE_SYMLINK' },
    )

    const linkedRoot = path.join(root, 'linked-root')
    await symlink(realInput, linkedRoot, 'dir')
    await assert.rejects(
      () => generateStaticVariants({ manifest: [baseEntry], imageRoot: linkedRoot, publicRoot }),
      { code: 'IMAGE_ROOT_SYMLINK' },
    )

    const linkedAncestor = path.join(root, 'linked-ancestor')
    await symlink(root, linkedAncestor, 'dir')
    await assert.rejects(
      () => generateStaticVariants({ manifest: [baseEntry], imageRoot: path.join(linkedAncestor, 'real-input'), publicRoot }),
      { code: 'IMAGE_ROOT_SYMLINK' },
    )
  })
})

test('the Vite guard blocks source JPEG imports, including URL and Windows path forms', () => {
  const guard = createSourceJpegImportGuard([baseEntry])
  for (const source of [
    '../input/test-image.jpg?import',
    'C:\\fixture\\input\\test-image.jpg#asset',
    '/fixture/input/test-image%2Ejpg?url',
  ]) {
    assert.throws(() => guard.resolveId(source), /transformed at build time/)
  }
  assert.equal(guard.resolveId('../input/other.jpg?import'), undefined)
})
