import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { resolveImageVariantsConfig } from './config.mjs'

const MAX_INPUT_PIXELS = 10_000_000
const TRANSFORM_POLICY = 'v1-webp-q82-e4'

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  throw error
}

function safeVersion(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_')
}

export const IMAGE_VARIANTS_TRANSFORM_NAMESPACE = [
  TRANSFORM_POLICY,
  `sharp-${safeVersion(sharp.versions.sharp)}`,
  `vips-${safeVersion(sharp.versions.vips)}`,
].join('__')

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function trustedDirectory(candidate, label, { create = false } = {}) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    fail(`${label}_UNAVAILABLE`, `The trusted ${label.toLowerCase()} directory is unavailable.`)
  }
  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  try {
    for (const component of components) {
      current = path.join(current, component)
      let stat
      try {
        stat = await lstat(current)
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error
        try {
          await mkdir(current)
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError
        }
        stat = await lstat(current)
      }
      if (stat.isSymbolicLink()) fail(`${label}_SYMLINK`, `The trusted ${label.toLowerCase()} path must not contain symbolic links.`)
      if (!stat.isDirectory()) fail(`${label}_NOT_DIRECTORY`, `The trusted ${label.toLowerCase()} path contains a non-directory component.`)
    }
    return await realpath(absolute)
  } catch (error) {
    if (error.code?.startsWith(`${label}_`)) throw error
    fail(`${label}_UNAVAILABLE`, `The trusted ${label.toLowerCase()} directory is unavailable.`, error)
  }
}

async function readSource(entry, sourceRoot) {
  const candidate = path.join(sourceRoot, entry.file)
  let before
  try {
    before = await lstat(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
    fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source could not be inspected.', error)
  }
  if (before.isSymbolicLink()) fail('IMAGE_SOURCE_SYMLINK', 'Symbolic-link image sources are not trusted.')
  if (!before.isFile()) fail('IMAGE_SOURCE_NOT_FILE', 'The trusted image source is not a regular file.')
  if (before.size > entry.maxBytes) fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')

  let canonical
  try {
    canonical = await realpath(candidate)
  } catch {
    fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
  }
  if (!isWithinDirectory(sourceRoot, canonical)) fail('IMAGE_SOURCE_ESCAPE', 'The image source resolves outside its trusted directory.')

  let handle
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error.code === 'ELOOP') fail('IMAGE_SOURCE_SYMLINK', 'Symbolic-link image sources are not trusted.')
    fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source could not be opened.', error)
  }

  let bytes
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) fail('IMAGE_SOURCE_NOT_FILE', 'The trusted image source is not a regular file.')
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('IMAGE_SOURCE_CHANGED', 'The trusted image source changed while it was being opened.')
    }
    if (opened.size > entry.maxBytes) fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')
    const chunks = []
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, entry.maxBytes + 1))
    let total = 0
    while (total <= entry.maxBytes) {
      const length = Math.min(buffer.byteLength, entry.maxBytes + 1 - total)
      const { bytesRead } = await handle.read(buffer, 0, length, total)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
    }
    if (total > entry.maxBytes) fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('IMAGE_SOURCE_CHANGED', 'The trusted image source changed while it was being read.')
    }
    bytes = Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }

  let metadata
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch (error) {
    if (/pixel limit/i.test(error.message)) {
      fail('IMAGE_DIMENSIONS_TOO_LARGE', 'The trusted image source exceeds its pixel limit.', error)
    }
    fail('INVALID_IMAGE', 'The trusted image source is not a readable JPEG.', error)
  }
  if (metadata.format !== 'jpeg') fail('IMAGE_FORMAT_MISMATCH', 'The trusted image source does not contain JPEG data.')
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
      metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > entry.maxPixels) {
    fail('IMAGE_DIMENSIONS_TOO_LARGE', 'The trusted image source exceeds its pixel limit or has invalid dimensions.')
  }
  if (entry.widths.some((width) => width > metadata.width)) {
    fail('INVALID_IMAGE_MANIFEST', 'Responsive widths must not enlarge the source image.')
  }
  return { bytes, metadata }
}

async function readRegularFile(candidate, label, { withIdentity = false } = {}) {
  let before
  try {
    before = await lstat(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    fail(`${label}_UNAVAILABLE`, 'A generated image variant could not be inspected.', error)
  }
  if (before.isSymbolicLink()) fail(`${label}_SYMLINK`, 'Generated image variants must not be symbolic links.')
  if (!before.isFile()) fail(`${label}_NOT_FILE`, 'A generated image variant is not a regular file.')
  let handle
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error.code === 'ELOOP') fail(`${label}_SYMLINK`, 'Generated image variants must not be symbolic links.')
    fail(`${label}_UNAVAILABLE`, 'A generated image variant could not be opened.', error)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) fail(`${label}_NOT_FILE`, 'A generated image variant is not a regular file.')
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(`${label}_CHANGED`, 'A generated image variant changed while it was being inspected.')
    }
    const bytes = await handle.readFile()
    return withIdentity ? { bytes, identity: { dev: opened.dev, ino: opened.ino } } : bytes
  } finally {
    await handle.close()
  }
}

async function cachedVariantMetadata(bytes, width, height) {
  let metadata
  try {
    metadata = await sharp(bytes).metadata()
  } catch {
    return null
  }
  if (metadata.format !== 'webp' || metadata.width !== width || metadata.height !== height) return null
  return { width: metadata.width, height: metadata.height }
}

async function inspectCachedVariant(filename, width, height) {
  const bytes = await readRegularFile(filename, 'VARIANT_CACHE')
  if (!bytes) return null
  const metadata = await cachedVariantMetadata(bytes, width, height)
  return metadata ? { ...metadata, bytes } : null
}

async function createWebpVariant(bytes, maxPixels, width, expectedHeight) {
  const output = await sharp(bytes, { limitInputPixels: maxPixels })
    .resize({ width, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer()
  let metadata
  try {
    metadata = await sharp(output).metadata()
  } catch (error) {
    fail('VARIANT_GENERATION_FAILED', 'Sharp produced an unreadable WebP variant.', error)
  }
  if (metadata.format !== 'webp' || metadata.width !== width || metadata.height !== expectedHeight) {
    fail('VARIANT_GENERATION_FAILED', 'Sharp did not produce the expected WebP dimensions.')
  }
  return { output, metadata: { width: metadata.width, height: metadata.height } }
}

async function ensureHashDirectory(outputRoot, hashPrefix) {
  const directory = path.join(outputRoot, IMAGE_VARIANTS_TRANSFORM_NAMESPACE, hashPrefix)
  const namespaceDir = path.dirname(directory)
  for (const candidate of [namespaceDir, directory]) {
    let stat
    try {
      stat = await lstat(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try {
        await mkdir(candidate)
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError
      }
      stat = await lstat(candidate)
    }
    if (stat.isSymbolicLink()) fail('VARIANT_DIRECTORY_SYMLINK', 'Generated variant directories must not be symbolic links.')
    if (!stat.isDirectory()) fail('VARIANT_DIRECTORY_NOT_DIRECTORY', 'A generated variant path is not a directory.')
  }
  return directory
}

async function publishStagedVariant(stagedPath, outputPath, width, expectedHeight) {
  const stagedBytes = await readRegularFile(stagedPath, 'VARIANT_STAGE')
  if (!stagedBytes) fail('VARIANT_GENERATION_FAILED', 'A staged WebP variant is missing.')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await link(stagedPath, outputPath)
      return
    } catch (error) {
      if (error.code !== 'EEXIST') fail('VARIANT_GENERATION_FAILED', 'A generated WebP variant could not be published.', error)
    }

    const existing = await readRegularFile(outputPath, 'VARIANT_CACHE', { withIdentity: true })
    if (!existing) continue
    if (existing.bytes.equals(stagedBytes)) return
    if (await cachedVariantMetadata(existing.bytes, width, expectedHeight)) {
      fail('VARIANT_CONTENT_COLLISION', 'A content-addressed variant path already contains different bytes.')
    }

    // Re-read immediately before replacement. A concurrent publisher may have
    // repaired the entry since it was inspected; never replace that newer (and
    // possibly valid) cache entry, including an in-place rewrite of its inode.
    const current = await readRegularFile(outputPath, 'VARIANT_CACHE', { withIdentity: true })
    if (!current) continue
    if (current.bytes.equals(stagedBytes)) return
    if (await cachedVariantMetadata(current.bytes, width, expectedHeight)) {
      fail('VARIANT_CONTENT_COLLISION', 'A content-addressed variant path already contains different bytes.')
    }
    if (current.identity.dev !== existing.identity.dev || current.identity.ino !== existing.identity.ino) continue

    try {
      await rename(stagedPath, outputPath)
      return
    } catch (error) {
      fail('VARIANT_GENERATION_FAILED', 'An invalid cached WebP variant could not be repaired.', error)
    }
  }

  fail('VARIANT_CACHE_CHANGED', 'A generated image variant changed repeatedly while it was being published.')
}

function joinPublicPath(publicPath, ...parts) {
  const prefix = publicPath === '/' ? '' : publicPath
  return `${prefix}/${parts.join('/')}` || '/'
}

/** Generate immutable, public WebP variants from a V1 JPEG manifest. */
export async function generateImageVariants(options) {
  const config = resolveImageVariantsConfig(options)
  const sourceRoot = await trustedDirectory(config.sourceRoot, 'IMAGE_ROOT')
  const outputRoot = await trustedDirectory(config.outputDir, 'OUTPUT_ROOT', { create: true })
  const images = []
  const staged = []
  let stageDirectory

  async function getStageDirectory() {
    if (!stageDirectory) stageDirectory = await mkdtemp(path.join(outputRoot, '.image-variants-stage-'))
    return stageDirectory
  }

  try {
    for (const entry of config.manifest.images) {
      const { bytes, metadata } = await readSource(entry, sourceRoot)
      const contentHash = createHash('sha256').update(bytes).digest('hex')
      const hashPrefix = contentHash.slice(0, 2)
      const hashDirectory = await ensureHashDirectory(outputRoot, hashPrefix)
      const variants = []
      let allCached = true

      for (const width of entry.widths) {
        const relativePath = path.join(IMAGE_VARIANTS_TRANSFORM_NAMESPACE, hashPrefix, `${contentHash}_${width}.webp`)
        const outputPath = path.join(hashDirectory, `${contentHash}_${width}.webp`)
        const expectedHeight = Math.round(metadata.height * width / metadata.width)
        const cached = await inspectCachedVariant(outputPath, width, expectedHeight)
        if (!cached) allCached = false
        variants.push({
          outputPath,
          width,
          expectedHeight,
          cached,
          url: joinPublicPath(config.publicPath, ...relativePath.split(path.sep)),
        })
      }

      if (allCached) {
        for (const variant of variants) {
          const expected = await createWebpVariant(bytes, entry.maxPixels, variant.width, variant.expectedHeight)
          if (!variant.cached.bytes.equals(expected.output)) {
            fail('VARIANT_CONTENT_COLLISION', 'A content-addressed variant path already contains different bytes.')
          }
          variant.cached = expected.metadata
        }
      } else {
        const stagingDir = await getStageDirectory()
        for (const [index, variant] of variants.entries()) {
          const { output, metadata: outputMetadata } = await createWebpVariant(
            bytes,
            entry.maxPixels,
            variant.width,
            variant.expectedHeight,
          )
          const stagedPath = path.join(stagingDir, `${images.length}-${index}-${variant.width}.webp`)
          await writeFile(stagedPath, output, { flag: 'wx' })
          staged.push({
            stagedPath,
            outputPath: variant.outputPath,
            width: variant.width,
            expectedHeight: variant.expectedHeight,
          })
          variant.cached = outputMetadata
        }
      }

      images.push({
        slug: entry.slug,
        width: metadata.width,
        height: metadata.height,
        variants: variants.map(({ url, cached }) => ({
          url,
          format: 'webp',
          width: cached.width,
          height: cached.height,
        })),
      })
    }

    for (const item of staged) {
      const outputDirectory = path.dirname(item.outputPath)
      await ensureHashDirectory(outputRoot, path.basename(outputDirectory))
      await publishStagedVariant(item.stagedPath, item.outputPath, item.width, item.expectedHeight)
    }

    return Object.freeze({
      version: 1,
      transformNamespace: IMAGE_VARIANTS_TRANSFORM_NAMESPACE,
      images: Object.freeze(images.map((image) => Object.freeze({
        ...image,
        variants: Object.freeze(image.variants.map((variant) => Object.freeze(variant))),
      }))),
    })
  } finally {
    if (stageDirectory) await rm(stageDirectory, { recursive: true, force: false })
  }
}
