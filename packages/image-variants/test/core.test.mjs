import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  generateImageVariants,
  IMAGE_VARIANTS_TRANSFORM_NAMESPACE,
  toImageMetadata,
  toResponsiveImage,
} from '../src/index.mjs'

const BASE_ENTRY = Object.freeze({
  slug: 'sample-cover',
  file: 'sample-cover.jpg',
  format: 'jpeg',
  maxBytes: 1_000_000,
  maxPixels: 100_000,
  widths: [8, 16],
})

async function withWorkspace(callback) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'image-variants-core-'))
  try {
    const sourceRoot = path.join(root, 'source')
    const outputDir = path.join(root, 'public', 'variants')
    await mkdir(sourceRoot)
    const pixels = Buffer.alloc(32 * 16 * 3)
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 29 + 13) % 256
    const sourceBytes = await sharp(pixels, { raw: { width: 32, height: 16, channels: 3 } })
      .jpeg({ quality: 87, chromaSubsampling: '4:4:4' })
      .toBuffer()
    await writeFile(path.join(sourceRoot, BASE_ENTRY.file), sourceBytes, { flag: 'wx' })
    return await callback({ root, sourceRoot, outputDir, sourceBytes })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function sourceManifest(images = [BASE_ENTRY]) {
  return { version: 1, images }
}

function configFor({ manifest = sourceManifest(), sourceRoot, outputDir }) {
  return { manifest, sourceRoot, outputDir, publicPath: '/variants' }
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

test('full original-source SHA-256 is shared by all widths and namespaced by transform versions', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir, sourceBytes }) => {
    const result = await generateImageVariants(configFor({ manifest: sourceManifest(), sourceRoot, outputDir }))
    const image = result.images[0]
    const hash = createHash('sha256').update(sourceBytes).digest('hex')
    assert.equal(hash.length, 64)
    assert.equal(result.transformNamespace, IMAGE_VARIANTS_TRANSFORM_NAMESPACE)
    assert.match(result.transformNamespace, /^v1-webp-q82-e4__sharp-.+__vips-.+$/)
    assert.deepEqual(image.variants.map(({ url, format, width }) => [url, format, width]), [
      [`/variants/${result.transformNamespace}/${hash.slice(0, 2)}/${hash}_8.webp`, 'webp', 8],
      [`/variants/${result.transformNamespace}/${hash.slice(0, 2)}/${hash}_16.webp`, 'webp', 16],
    ])
    assert.deepEqual(toImageMetadata(image), {
      src: image.variants[1].url,
      width: 32,
      height: 16,
      format: 'webp',
    })
    assert.equal(toResponsiveImage(image, { sizes: '(max-width: 32rem) 100vw, 32rem' }).srcset,
      `${image.variants[0].url} 8w, ${image.variants[1].url} 16w`)
    assert.equal(toResponsiveImage(image, { sizes: '50vw' }).sizes, '50vw')
  })
})

test('a complete cache is reused; a missing expected width is regenerated without pruning old entries', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir }) => {
    const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
    const first = await generateImageVariants(options)
    const outputPaths = first.images[0].variants.map(({ url }) => path.join(outputDir, url.split('/').slice(2).join('/')))
    const firstStats = await Promise.all(outputPaths.map((outputPath) => stat(outputPath)))

    const repeated = await generateImageVariants(options)
    assert.deepEqual(repeated, first)
    const repeatedStats = await Promise.all(outputPaths.map((outputPath) => stat(outputPath)))
    assert.deepEqual(repeatedStats.map(({ ino }) => ino), firstStats.map(({ ino }) => ino))

    const firstBytes = await readFile(outputPaths[0])
    await unlink(outputPaths[0])
    const repaired = await generateImageVariants(options)
    assert.deepEqual(repaired, first)
    assert.deepEqual(await readFile(outputPaths[0]), firstBytes)
    assert.equal((await readdir(outputDir)).some((name) => name.startsWith('.image-variants-stage-')), false)
  })
})

test('malformed and wrong-dimension regular cache files are atomically regenerated', async () => {
  for (const corrupt of [
    async () => Buffer.from('not a WebP'),
    async () => sharp({ create: { width: 7, height: 4, channels: 3, background: '#f00' } }).webp().toBuffer(),
    async () => sharp({ create: { width: 8, height: 5, channels: 3, background: '#0f0' } }).webp().toBuffer(),
  ]) {
    await withWorkspace(async ({ sourceRoot, outputDir }) => {
      const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
      const first = await generateImageVariants(options)
      const outputPath = path.join(outputDir, first.images[0].variants[0].url.split('/').slice(2).join('/'))
      const expectedBytes = await readFile(outputPath)
      await writeFile(outputPath, await corrupt())

      const repaired = await generateImageVariants(options)
      assert.deepEqual(repaired, first)
      assert.deepEqual(await readFile(outputPath), expectedBytes)
      const metadata = await sharp(outputPath).metadata()
      assert.equal(metadata.format, 'webp')
      assert.equal(metadata.width, 8)
      assert.equal(metadata.height, 4)
      assert.equal((await readdir(outputDir)).some((name) => name.startsWith('.image-variants-stage-')), false)
    })
  }
})

test('a valid but different WebP at a content-addressed path is never replaced', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir }) => {
    const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
    const generated = await generateImageVariants(options)
    const outputPaths = generated.images[0].variants.map(({ url }) => path.join(outputDir, url.split('/').slice(2).join('/')))
    const differentValidWebp = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#f00' } })
      .webp()
      .toBuffer()
    assert.notDeepEqual(differentValidWebp, await readFile(outputPaths[0]))
    await writeFile(outputPaths[0], differentValidWebp)
    await unlink(outputPaths[1])

    await assert.rejects(() => generateImageVariants(options), { code: 'VARIANT_CONTENT_COLLISION' })
    assert.deepEqual(await readFile(outputPaths[0]), differentValidWebp)
    assert.equal((await readdir(outputDir)).some((name) => name.startsWith('.image-variants-stage-')), false)
  })
})

test('a complete cache with valid but different WebP content fails integrity verification', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir }) => {
    const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
    const generated = await generateImageVariants(options)
    const outputPaths = generated.images[0].variants.map(({ url }) => path.join(outputDir, url.split('/').slice(2).join('/')))
    const replacements = await Promise.all([
      sharp({ create: { width: 8, height: 4, channels: 3, background: '#f00' } }).webp().toBuffer(),
      sharp({ create: { width: 16, height: 8, channels: 3, background: '#0f0' } }).webp().toBuffer(),
    ])
    for (const [index, outputPath] of outputPaths.entries()) {
      assert.notDeepEqual(replacements[index], await readFile(outputPath))
      await writeFile(outputPath, replacements[index])
    }

    await assert.rejects(() => generateImageVariants(options), { code: 'VARIANT_CONTENT_COLLISION' })
    for (const [index, outputPath] of outputPaths.entries()) {
      assert.deepEqual(await readFile(outputPath), replacements[index], 'A valid but conflicting cache file must not be overwritten.')
    }
    assert.equal((await readdir(outputDir)).some((name) => name.startsWith('.image-variants-stage-')), false)
  })
})

test('a symlink at a cached variant path is rejected without touching its target', async () => {
  await withWorkspace(async ({ root, sourceRoot, outputDir }) => {
    const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
    const generated = await generateImageVariants(options)
    const outputPath = path.join(outputDir, generated.images[0].variants[0].url.split('/').slice(2).join('/'))
    const outsidePath = path.join(root, 'outside.webp')
    const outsideBytes = Buffer.from('outside target must remain untouched')
    await writeFile(outsidePath, outsideBytes)
    await unlink(outputPath)
    await symlink(outsidePath, outputPath)

    await assert.rejects(() => generateImageVariants(options), { code: 'VARIANT_CACHE_SYMLINK' })
    assert.deepEqual(await readFile(outsidePath), outsideBytes)
  })
})

test('changed source bytes add a new full-hash set and leave previous cache files intact', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir, sourceBytes }) => {
    const options = configFor({ manifest: sourceManifest(), sourceRoot, outputDir })
    const before = await generateImageVariants(options)
    const oldPaths = before.images[0].variants.map(({ url }) => path.join(outputDir, url.split('/').slice(2).join('/')))
    const decoded = await sharp(sourceBytes).raw().toBuffer()
    const changedPixels = Buffer.from(decoded)
    for (let index = 0; index < changedPixels.length; index += 1) changedPixels[index] = 255 - changedPixels[index]
    const changedBytes = await sharp(changedPixels, { raw: { width: 32, height: 16, channels: 3 } })
      .jpeg({ quality: 87, chromaSubsampling: '4:4:4' })
      .toBuffer()
    await writeFile(path.join(sourceRoot, BASE_ENTRY.file), changedBytes)

    const after = await generateImageVariants(options)
    assert.notDeepEqual(after.images[0].variants.map(({ url }) => url), before.images[0].variants.map(({ url }) => url))
    for (const oldPath of oldPaths) assert.ok(await readFile(oldPath))
    assert.equal(createHash('sha256').update(changedBytes).digest('hex').length, 64)
  })
})

test('a failed later image does not publish an incomplete variant set', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir }) => {
    const previous = await generateImageVariants(configFor({ manifest: sourceManifest(), sourceRoot, outputDir }))
    const previousPaths = previous.images[0].variants.map(({ url }) => path.join(outputDir, url.split('/').slice(2).join('/')))
    const previousBytes = await Promise.all(previousPaths.map((filename) => readFile(filename)))
    await writeFile(path.join(sourceRoot, 'broken.jpg'), Buffer.from('synthetic invalid jpeg'))
    await assert.rejects(() => generateImageVariants(configFor({
      manifest: sourceManifest([
        BASE_ENTRY,
        { ...BASE_ENTRY, slug: 'broken-image', file: 'broken.jpg' },
      ]),
      sourceRoot,
      outputDir,
    })), { code: 'INVALID_IMAGE' })
    const outputFiles = await listFiles(outputDir)
    assert.deepEqual(outputFiles.filter((name) => name.endsWith('.webp')).sort(), [...previousPaths].sort())
    for (const [index, filename] of previousPaths.entries()) assert.deepEqual(await readFile(filename), previousBytes[index])
    assert.equal(outputFiles.some((name) => path.basename(name).startsWith('.image-variants-stage-')), false)
  })
})

test('source byte and pixel limits fail closed without touching source bytes', async () => {
  await withWorkspace(async ({ sourceRoot, outputDir, sourceBytes }) => {
    await assert.rejects(() => generateImageVariants(configFor({
      manifest: sourceManifest([{ ...BASE_ENTRY, maxBytes: sourceBytes.length - 1 }]),
      sourceRoot,
      outputDir,
    })), { code: 'IMAGE_SOURCE_TOO_LARGE' })
    await assert.rejects(() => generateImageVariants(configFor({
      manifest: sourceManifest([{ ...BASE_ENTRY, maxPixels: 100 }]),
      sourceRoot,
      outputDir,
    })), { code: 'IMAGE_DIMENSIONS_TOO_LARGE' })
    assert.deepEqual(await readFile(path.join(sourceRoot, BASE_ENTRY.file)), sourceBytes)
  })
})
