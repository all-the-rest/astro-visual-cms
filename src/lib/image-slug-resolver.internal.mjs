import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { IMAGE_MANIFEST } from './demo-image-manifest.mjs'

// Astro/Vite injects the config-rooted source path so prerender chunks never
// infer project layout from their own dist/.prerender location. The fallback is
// only for direct Node use (including focused tests), not standalone bundles.
const IMAGE_ROOT = typeof __ASTRO_VISUAL_CMS_IMAGE_ROOT__ === 'string'
  ? __ASTRO_VISUAL_CMS_IMAGE_ROOT__
  : fileURLToPath(new URL('../../public/images/', import.meta.url))
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
const FORMAT_EXTENSIONS = Object.freeze({
  jpeg: new Set(['.jpg', '.jpeg']),
  png: new Set(['.png']),
  webp: new Set(['.webp']),
})
const MANIFEST_KEYS = ['file', 'format', 'maxBytes', 'maxPixels', 'slug']

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validateManifestEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must be a plain object.`)
  }

  const keys = Object.keys(entry).sort()
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, keyIndex) => key !== MANIFEST_KEYS[keyIndex])) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has an unexpected shape.`)
  }
  if (typeof entry.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has an invalid slug.`)
  }
  if (typeof entry.file !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/.test(entry.file) ||
      path.posix.basename(entry.file) !== entry.file || path.win32.basename(entry.file) !== entry.file ||
      entry.file === '.' || entry.file === '..') {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must name one local image file.`)
  }
  if (!Object.hasOwn(FORMAT_EXTENSIONS, entry.format) || !FORMAT_EXTENSIONS[entry.format].has(path.extname(entry.file))) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has a file extension that does not match its format.`)
  }
  if (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > MAX_SOURCE_BYTES ||
      !Number.isSafeInteger(entry.maxPixels) || entry.maxPixels < 1 || entry.maxPixels > MAX_IMAGE_PIXELS) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has invalid size limits.`)
  }

  return Object.freeze({
    slug: entry.slug,
    file: entry.file,
    format: entry.format,
    maxBytes: entry.maxBytes,
    maxPixels: entry.maxPixels,
  })
}

/** Validate and snapshot the explicit, trusted manifest before resolving it. */
export function validateImageManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    fail('INVALID_IMAGE_MANIFEST', 'The image manifest must be a non-empty array.')
  }

  const slugs = new Set()
  const files = new Set()
  return Object.freeze(manifest.map((entry, index) => {
    const validated = validateManifestEntry(entry, index)
    const fileKey = validated.file.normalize('NFC').toLocaleLowerCase('en-US')
    if (slugs.has(validated.slug)) fail('DUPLICATE_IMAGE_SLUG', 'The image manifest contains a duplicate slug.')
    if (files.has(fileKey)) fail('DUPLICATE_IMAGE_FILE', 'The image manifest contains a duplicate source file.')
    slugs.add(validated.slug)
    files.add(fileKey)
    return validated
  }))
}

function sanitizedFilesystemError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function canonicalPath(candidate, imageRoot) {
  let sourceStat
  try {
    sourceStat = await lstat(candidate)
  } catch {
    throw sanitizedFilesystemError('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
  }

  if (sourceStat.isSymbolicLink()) {
    let target
    try {
      target = await realpath(candidate)
    } catch {
      throw sanitizedFilesystemError('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
    }
    if (!isWithinDirectory(imageRoot, target)) {
      throw sanitizedFilesystemError('IMAGE_SOURCE_ESCAPE', 'The image source resolves outside the trusted image directory.')
    }
    throw sanitizedFilesystemError('IMAGE_SOURCE_SYMLINK', 'Symbolic-link image sources are not trusted.')
  }
  if (!sourceStat.isFile()) {
    throw sanitizedFilesystemError('IMAGE_SOURCE_NOT_FILE', 'The trusted image source is not a regular file.')
  }

  let canonical
  try {
    canonical = await realpath(candidate)
  } catch {
    throw sanitizedFilesystemError('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
  }
  if (!isWithinDirectory(imageRoot, canonical)) {
    throw sanitizedFilesystemError('IMAGE_SOURCE_ESCAPE', 'The image source resolves outside the trusted image directory.')
  }
  return { canonical, sourceStat }
}

async function readBoundedSource(sourcePath, maxBytes) {
  let handle
  try {
    handle = await open(sourcePath, 'r')
  } catch {
    throw sanitizedFilesystemError('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
  }

  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      fail('IMAGE_SOURCE_NOT_FILE', 'The trusted image source is not a regular file.')
    }
    if (openedStat.size > maxBytes) {
      fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')
    }

    // Bound allocation and reads even if a trusted local file grows after stat.
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxBytes) {
      fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')
    }
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    if (error.code === 'IMAGE_SOURCE_NOT_FILE' || error.code === 'IMAGE_SOURCE_TOO_LARGE') throw error
    throw sanitizedFilesystemError('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
  } finally {
    await handle.close()
  }
}

async function canonicalTrustedDirectory(imageRoot) {
  if (typeof imageRoot !== 'string' || !path.isAbsolute(imageRoot) || imageRoot.split(path.sep).includes('..')) {
    throw sanitizedFilesystemError('IMAGE_DIRECTORY_UNAVAILABLE', 'The trusted image directory is unavailable.')
  }

  const absoluteRoot = path.resolve(imageRoot)
  const parsedRoot = path.parse(absoluteRoot)
  const components = absoluteRoot.slice(parsedRoot.root.length).split(path.sep).filter(Boolean)
  let current = parsedRoot.root

  try {
    const filesystemRootStat = await lstat(current)
    if (!filesystemRootStat.isDirectory()) {
      throw sanitizedFilesystemError('IMAGE_DIRECTORY_NOT_DIRECTORY', 'The trusted image directory is not a directory.')
    }

    for (const component of components) {
      current = path.join(current, component)
      const componentStat = await lstat(current)
      if (componentStat.isSymbolicLink()) {
        throw sanitizedFilesystemError('IMAGE_DIRECTORY_SYMLINK', 'The trusted image path must not contain symbolic links.')
      }
      if (!componentStat.isDirectory()) {
        throw sanitizedFilesystemError('IMAGE_DIRECTORY_NOT_DIRECTORY', 'The trusted image path contains a non-directory component.')
      }
    }

    return await realpath(absoluteRoot)
  } catch (error) {
    if (error.code === 'IMAGE_DIRECTORY_SYMLINK' || error.code === 'IMAGE_DIRECTORY_NOT_DIRECTORY') throw error
    throw sanitizedFilesystemError('IMAGE_DIRECTORY_UNAVAILABLE', 'The trusted image directory is unavailable.')
  }
}

/**
 * Internal resolver result for the Astro adapter. The source path is private
 * implementation data and must never be added to the public metadata contract.
 */
export async function resolveImageSource(slug, { manifest = IMAGE_MANIFEST, imageRoot = IMAGE_ROOT } = {}) {
  const entries = validateImageManifest(manifest)
  const entry = entries.find((candidate) => candidate.slug === slug)
  if (!entry) fail('UNKNOWN_IMAGE_SLUG', 'Unknown image slug.')

  const canonicalRoot = await canonicalTrustedDirectory(imageRoot)

  const candidate = path.join(canonicalRoot, entry.file)
  const { canonical, sourceStat } = await canonicalPath(candidate, canonicalRoot)
  if (sourceStat.size > entry.maxBytes) {
    fail('IMAGE_SOURCE_TOO_LARGE', 'The trusted image source exceeds its byte limit.')
  }

  const bytes = await readBoundedSource(canonical, entry.maxBytes)

  let dimensions
  try {
    dimensions = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  } catch (error) {
    if (/pixel limit/i.test(error.message)) {
      fail('IMAGE_DIMENSIONS_TOO_LARGE', 'The trusted image source exceeds its pixel limit.')
    }
    fail('INVALID_IMAGE', 'The trusted image source is not a readable image.')
  }
  if (dimensions.format !== entry.format) {
    fail('IMAGE_FORMAT_MISMATCH', 'The trusted image source does not match its declared format.')
  }
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > entry.maxPixels) {
    fail('IMAGE_DIMENSIONS_TOO_LARGE', 'The trusted image source exceeds its pixel limit or has invalid dimensions.')
  }

  const contentHash = createHash('sha256').update(bytes).digest('hex')
  return {
    metadata: {
      src: `/images/${encodeURIComponent(entry.file)}?content=${contentHash}`,
      width: dimensions.width,
      height: dimensions.height,
      format: dimensions.format,
    },
    sourcePath: canonical,
  }
}
