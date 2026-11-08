import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { generateImageVariants } from '../src/core.mjs'
import { projectLegacyManifest, writeLegacyVariantArtifacts } from '../src/legacy-cdn.mjs'
import { publishStagedOverwrites } from '../src/legacy-cdn-internal.mjs'

const NAMESPACE = 'v1-webp-q82-e4__sharp-0.35.5__vips-8.17.0'
const GENERATED = '2026-11-08T12:34:56.789Z'
const FULL_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

async function withWorkspace(callback) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'image-variants-legacy-'))
  try {
    const sourceDir = path.join(root, 'v1')
    const outputDir = path.join(root, 'legacy-output')
    await mkdir(sourceDir)
    return await callback({ root, sourceDir, outputDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function resultFor({
  hash = FULL_HASH,
  slug = 'sample-cover',
  widths = [8, 16],
  publicPath = '/variants',
  namespace = NAMESPACE,
  imageWidth = 32,
  imageHeight = 16,
} = {}) {
  return {
    version: 1,
    transformNamespace: namespace,
    images: [{
      slug,
      width: imageWidth,
      height: imageHeight,
      variants: widths.map((width) => ({
        url: `${publicPath}/${namespace}/${hash.slice(0, 2)}/${hash}_${width}.webp`,
        format: 'webp',
        width,
        height: Math.round(imageHeight * width / imageWidth),
      })),
    }],
  }
}

function optionsFor({ sourceDir, outputDir, extra = {} }) {
  return {
    sourceDir,
    outputDir,
    publicPath: '/variants',
    generated: GENERATED,
    ...extra,
  }
}

async function writeSyntheticV1Files(sourceDir, result, bytesFor = ({ width }) => Buffer.from(`synthetic-${width}`)) {
  for (const image of result.images) {
    const match = /\/([a-f0-9]{2})\/([a-f0-9]{64})_\d+\.webp$/.exec(image.variants[0].url)
    const [, prefix, hash] = match
    const directory = path.join(sourceDir, result.transformNamespace, prefix)
    await mkdir(directory, { recursive: true })
    for (const variant of image.variants) {
      await writeFile(path.join(directory, `${hash}_${variant.width}.webp`), bytesFor({ image, variant, width: variant.width }), { flag: 'wx' })
    }
  }
}

function v1SourcePath(result, width, image = result.images[0]) {
  const match = /\/([a-f0-9]{2})\/([a-f0-9]{64})_\d+\.webp$/.exec(image.variants[0].url)
  const [, prefix, hash] = match
  return path.join(result.transformNamespace, prefix, `${hash}_${width}.webp`)
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(filename))
    else if (entry.isFile()) files.push(filename)
  }
  return files
}

test('projection emits only the exact legacy manifest fields and validated URL/object-key metadata', () => {
  const result = projectLegacyManifest(resultFor(), {
    publicPath: '/variants',
    generated: GENERATED,
    baseUrl: 'https://cdn.example.test',
  })

  assert.deepEqual(result.manifest, {
    version: 1,
    generated: GENERATED,
    images: {
      'sample-cover': {
        hash: '0123456789abcdef',
        width: 32,
        height: 16,
        variants: [8, 16],
      },
    },
  })
  assert.deepEqual(result.artifacts, [
    {
      slug: 'sample-cover',
      width: 8,
      url: 'https://cdn.example.test/01/0123456789abcdef_8.webp',
      objectKey: '01/0123456789abcdef_8.webp',
    },
    {
      slug: 'sample-cover',
      width: 16,
      url: 'https://cdn.example.test/01/0123456789abcdef_16.webp',
      objectKey: '01/0123456789abcdef_16.webp',
    },
  ])
  assert.deepEqual(Object.keys(result.manifest), ['version', 'generated', 'images'])
  assert.deepEqual(Object.keys(result.manifest.images['sample-cover']), ['hash', 'width', 'height', 'variants'])
})

test('the V1 generator continues to expose the complete original-source SHA-256 in every URL', async () => {
  await withWorkspace(async ({ root }) => {
    const sourceRoot = path.join(root, 'jpeg-source')
    const outputDir = path.join(root, 'v1-output')
    await mkdir(sourceRoot)
    const pixels = Buffer.alloc(32 * 16 * 3, 73)
    const source = await sharp(pixels, { raw: { width: 32, height: 16, channels: 3 } }).jpeg().toBuffer()
    await writeFile(path.join(sourceRoot, 'synthetic.jpg'), source)
    const generated = await generateImageVariants({
      manifest: {
        version: 1,
        images: [{
          slug: 'synthetic-cover',
          file: 'synthetic.jpg',
          format: 'jpeg',
          maxBytes: 1_000_000,
          maxPixels: 100_000,
          widths: [8, 16],
        }],
      },
      sourceRoot,
      outputDir,
      publicPath: '/variants',
    })
    const expectedHash = createHash('sha256').update(source).digest('hex')
    assert.equal(expectedHash.length, 64)
    assert.deepEqual(generated.images[0].variants.map(({ url }) => url.match(/[a-f0-9]{64}_\d+\.webp$/)?.[0]), [
      `${expectedHash}_8.webp`, `${expectedHash}_16.webp`,
    ])
  })
})

test('malformed shapes, URLs, mixed hashes, duplicate slugs, and duplicate legacy paths fail closed', () => {
  const options = { publicPath: '/variants', generated: GENERATED }
  const malformed = resultFor()
  malformed.images[0].variants[0].url = `/variants/${NAMESPACE}/../01/${FULL_HASH}_8.webp`
  assert.throws(() => projectLegacyManifest(malformed, options), { code: 'INVALID_LEGACY_URL' })

  const badWidth = resultFor()
  badWidth.images[0].variants[0].url = badWidth.images[0].variants[0].url.replace('_8.webp', '_9.webp')
  assert.throws(() => projectLegacyManifest(badWidth, options), { code: 'INVALID_LEGACY_URL' })

  const mixedHashes = resultFor()
  const otherHash = `fedcba9876543210${'f'.repeat(48)}`
  mixedHashes.images[0].variants[1].url = `/variants/${NAMESPACE}/fe/${otherHash}_16.webp`
  assert.throws(() => projectLegacyManifest(mixedHashes, options), { code: 'MIXED_LEGACY_SOURCE_HASHES' })

  const sameImageCollision = resultFor()
  const collidingHash = `0123456789abcdef${'f'.repeat(48)}`
  sameImageCollision.images[0].variants[1].url = `/variants/${NAMESPACE}/01/${collidingHash}_16.webp`
  assert.throws(() => projectLegacyManifest(sameImageCollision, options), { code: 'LEGACY_HASH_COLLISION' })

  const duplicateSlug = resultFor()
  duplicateSlug.images.push(structuredClone(duplicateSlug.images[0]))
  assert.throws(() => projectLegacyManifest(duplicateSlug, options), { code: 'DUPLICATE_LEGACY_SLUG' })

  const duplicatePath = resultFor()
  duplicatePath.images.push({ ...structuredClone(duplicatePath.images[0]), slug: 'another-cover' })
  assert.throws(() => projectLegacyManifest(duplicatePath, options), { code: 'DUPLICATE_LEGACY_PATH' })

  const extraShape = resultFor()
  extraShape.images[0].astroMetadata = { src: 'must-not-be-used' }
  assert.throws(() => projectLegacyManifest(extraShape, options), { code: 'INVALID_LEGACY_RESULT' })
})

test('truncated-hash collisions fail before creating or writing the legacy output directory', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const colliding = resultFor()
    const secondHash = `0123456789abcdef${'f'.repeat(48)}`
    colliding.images.push({
      slug: 'different-cover',
      width: 32,
      height: 16,
      variants: [{
        url: `/variants/${NAMESPACE}/01/${secondHash}_8.webp`,
        format: 'webp',
        width: 8,
        height: 4,
      }],
    })

    await assert.rejects(() => writeLegacyVariantArtifacts(colliding, optionsFor({ sourceDir, outputDir })), {
      code: 'LEGACY_HASH_COLLISION',
    })
    await assert.rejects(access(outputDir), { code: 'ENOENT' })
  })
})

test('copy writes only expected legacy artifacts byte-for-byte and leaves unrelated output files alone', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const result = resultFor()
    const expectedBytes = new Map([[8, Buffer.from([0, 1, 2, 255])], [16, Buffer.from('synthetic webp payload')]])
    await writeSyntheticV1Files(sourceDir, result, ({ width }) => expectedBytes.get(width))
    await mkdir(outputDir)
    await writeFile(path.join(outputDir, 'unrelated.txt'), 'leave me')

    const written = await writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir }))
    assert.deepEqual(written.invalidationUrls, [])
    for (const artifact of written.artifacts) {
      assert.deepEqual(await readFile(path.join(outputDir, artifact.objectKey)), expectedBytes.get(artifact.width))
    }
    assert.deepEqual((await listFiles(outputDir)).map((filename) => path.relative(outputDir, filename).split(path.sep).join('/')).sort(), [
      '01/0123456789abcdef_16.webp',
      '01/0123456789abcdef_8.webp',
      'unrelated.txt',
    ])
  })
})

test('existing legacy objects fail by default without changing their bytes', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const result = resultFor()
    await writeSyntheticV1Files(sourceDir, result)
    const initial = await writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir }))
    const filename = path.join(outputDir, initial.artifacts[0].objectKey)
    const original = await readFile(filename)
    await writeFile(path.join(sourceDir, v1SourcePath(result, initial.artifacts[0].width)), 'changed synthetic source')

    await assert.rejects(() => writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir })), {
      code: 'LEGACY_ARTIFACT_EXISTS',
    })
    assert.deepEqual(await readFile(filename), original)
  })
})

test('overwrite atomically replaces mutable legacy keys and returns exact CDN invalidation URLs', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const result = resultFor()
    await writeSyntheticV1Files(sourceDir, result, ({ width }) => Buffer.from(`old-${width}`))
    const first = await writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir }))
    for (const artifact of first.artifacts) {
      await writeFile(path.join(sourceDir, v1SourcePath(result, artifact.width)), Buffer.from(`new-${artifact.width}`))
    }

    const replaced = await writeLegacyVariantArtifacts(result, optionsFor({
      sourceDir,
      outputDir,
      extra: { overwrite: true, baseUrl: 'https://cdn.example.test' },
    }))
    assert.deepEqual(replaced.artifacts.map(({ objectKey }) => objectKey), first.artifacts.map(({ objectKey }) => objectKey))
    assert.deepEqual(replaced.invalidationUrls, [
      'https://cdn.example.test/01/0123456789abcdef_8.webp',
      'https://cdn.example.test/01/0123456789abcdef_16.webp',
    ])
    for (const artifact of replaced.artifacts) {
      assert.deepEqual(await readFile(path.join(outputDir, artifact.objectKey)), Buffer.from(`new-${artifact.width}`))
    }
  })
})

test('overwrite mode returns invalidation URLs for every published key even when keys were initially absent', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const result = resultFor()
    await writeSyntheticV1Files(sourceDir, result)
    const written = await writeLegacyVariantArtifacts(result, optionsFor({
      sourceDir,
      outputDir,
      extra: { overwrite: true },
    }))
    assert.deepEqual(written.invalidationUrls, written.artifacts.map(({ url }) => url))
  })
})

test('partial overwrite failure retains invalidation URLs for keys already published', async () => {
  const first = { url: 'https://cdn.example.test/01/first.webp' }
  const second = { url: 'https://cdn.example.test/01/second.webp' }
  await assert.rejects(() => publishStagedOverwrites([first, second], async (item) => {
    if (item === second) throw new Error('synthetic publish failure')
  }), (error) => {
    assert.equal(error.message, 'synthetic publish failure')
    assert.deepEqual(error.invalidationUrls, [first.url])
    return true
  })
})

test('writer rejects traversal and symlinked output paths without touching symlink targets', async () => {
  await withWorkspace(async ({ root, sourceDir, outputDir }) => {
    const result = resultFor()
    await writeSyntheticV1Files(sourceDir, result)
    await assert.rejects(() => writeLegacyVariantArtifacts(result, optionsFor({
      sourceDir,
      outputDir: path.parse(outputDir).root,
    })), { code: 'LEGACY_OUTPUT_ROOT_UNAVAILABLE' })

    const traversal = resultFor()
    traversal.images[0].variants[0].url = `/variants/${NAMESPACE}/01/../../outside.webp`
    await assert.rejects(() => writeLegacyVariantArtifacts(traversal, optionsFor({ sourceDir, outputDir })), {
      code: 'INVALID_LEGACY_URL',
    })
    await assert.rejects(access(outputDir), { code: 'ENOENT' })

    const outsideDir = path.join(root, 'outside')
    await mkdir(outsideDir)
    const outsideFile = path.join(outsideDir, 'sentinel.txt')
    await writeFile(outsideFile, 'untouched')
    await symlink(outsideDir, outputDir)
    await assert.rejects(() => writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir })), {
      code: 'LEGACY_OUTPUT_ROOT_SYMLINK',
    })
    assert.equal(await readFile(outsideFile, 'utf8'), 'untouched')

    await rm(outputDir)
    await mkdir(outputDir)
    await symlink(outsideDir, path.join(outputDir, '01'))
    await assert.rejects(() => writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir })), {
      code: 'LEGACY_OUTPUT_SYMLINK',
    })
    assert.equal(await readFile(outsideFile, 'utf8'), 'untouched')
  })
})

test('writer rejects oversized cached variants before allocating or creating output paths', async () => {
  await withWorkspace(async ({ sourceDir, outputDir }) => {
    const result = resultFor({ widths: [8] })
    await writeSyntheticV1Files(sourceDir, result)
    const sourcePath = path.join(sourceDir, v1SourcePath(result, 8))
    await truncate(sourcePath, 64 * 1024 * 1024 + 1)

    await assert.rejects(() => writeLegacyVariantArtifacts(result, optionsFor({ sourceDir, outputDir })), {
      code: 'LEGACY_ARTIFACT_LIMIT',
    })
    await assert.rejects(access(outputDir), { code: 'ENOENT' })
  })
})

test('public URL and timestamp inputs are narrowly validated', () => {
  const result = resultFor()
  for (const publicPath of ['/variants/', '/variants/../unsafe', '/variants%2fescape', 'https://cdn.example/variants']) {
    assert.throws(() => projectLegacyManifest(result, { publicPath, generated: GENERATED }), { code: 'INVALID_LEGACY_OPTIONS' })
  }
  for (const baseUrl of ['https://cdn.example/path', 'https://user:pass@cdn.example', 'https://cdn.example?cache=1']) {
    assert.throws(() => projectLegacyManifest(result, { publicPath: '/variants', generated: GENERATED, baseUrl }), {
      code: 'INVALID_LEGACY_OPTIONS',
    })
  }
  assert.throws(() => projectLegacyManifest(result, { publicPath: '/variants', generated: 'not a timestamp' }), {
    code: 'INVALID_LEGACY_OPTIONS',
  })
})
