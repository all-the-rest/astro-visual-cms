import path from 'node:path'
import { readFile } from 'node:fs/promises'

export const IMAGE_VARIANTS_LIMITS = Object.freeze({
  maxImages: 16,
  maxSourceBytes: 5 * 1024 * 1024,
  maxSourcePixels: 10_000_000,
  maxVariantsPerImage: 8,
  maxVariantWidth: 8192,
})

const MANIFEST_KEYS = ['images', 'version']
const IMAGE_KEYS = ['file', 'format', 'maxBytes', 'maxPixels', 'slug', 'widths']
const CONFIG_KEYS = ['manifest', 'outputDir', 'publicPath', 'sourceRoot']

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  throw error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort()
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
}

function validateImageEntry(entry, index) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, IMAGE_KEYS)) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has an unexpected shape.`)
  }
  if (typeof entry.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has an invalid slug.`)
  }
  if (typeof entry.file !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg)$/.test(entry.file) ||
      path.posix.basename(entry.file) !== entry.file || path.win32.basename(entry.file) !== entry.file) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must name one local JPEG file.`)
  }
  if (entry.format !== 'jpeg' || !['.jpg', '.jpeg'].includes(path.extname(entry.file))) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must declare JPEG input.`)
  }
  if (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > IMAGE_VARIANTS_LIMITS.maxSourceBytes ||
      !Number.isSafeInteger(entry.maxPixels) || entry.maxPixels < 1 || entry.maxPixels > IMAGE_VARIANTS_LIMITS.maxSourcePixels) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has invalid source limits.`)
  }
  if (!Array.isArray(entry.widths) || entry.widths.length < 1 || entry.widths.length > IMAGE_VARIANTS_LIMITS.maxVariantsPerImage ||
      entry.widths.some((width, widthIndex) => !Number.isSafeInteger(width) || width < 1 ||
        width > IMAGE_VARIANTS_LIMITS.maxVariantWidth || (widthIndex > 0 && width <= entry.widths[widthIndex - 1]))) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has invalid responsive widths.`)
  }

  return Object.freeze({
    slug: entry.slug,
    file: entry.file,
    format: entry.format,
    maxBytes: entry.maxBytes,
    maxPixels: entry.maxPixels,
    widths: Object.freeze([...entry.widths]),
  })
}

/** Validate and freeze the V1 technical source manifest. */
export function validateImageVariantsManifest(manifest) {
  if (!isPlainObject(manifest) || !hasExactKeys(manifest, MANIFEST_KEYS) || manifest.version !== 1 ||
      !Array.isArray(manifest.images) || manifest.images.length < 1 ||
      manifest.images.length > IMAGE_VARIANTS_LIMITS.maxImages) {
    fail('INVALID_IMAGE_MANIFEST', 'The image manifest must be a V1 object containing a bounded, non-empty image list.')
  }

  const slugs = new Set()
  const files = new Set()
  const images = manifest.images.map((entry, index) => {
    const validated = validateImageEntry(entry, index)
    const normalizedFile = validated.file.normalize('NFC').toLocaleLowerCase('en-US')
    if (slugs.has(validated.slug)) fail('DUPLICATE_IMAGE_SLUG', 'The image manifest contains a duplicate slug.')
    if (files.has(normalizedFile)) fail('DUPLICATE_IMAGE_FILE', 'The image manifest contains a duplicate source file.')
    slugs.add(validated.slug)
    files.add(normalizedFile)
    return validated
  })

  return Object.freeze({ version: 1, images: Object.freeze(images) })
}

function resolveDirectory(value, label, baseDir) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('INVALID_IMAGE_CONFIG', `${label} must be a non-empty filesystem path.`)
  }
  return path.resolve(baseDir, value)
}

function validatePublicPath(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/') ||
      publicPath.includes('\\') || publicPath.includes('\0') || publicPath.includes('?') || publicPath.includes('#') ||
      /\s/u.test(publicPath) || publicPath.includes('//') || publicPath.split('/').some((part) => part === '.' || part === '..')) {
    fail('INVALID_IMAGE_CONFIG', 'publicPath must be a canonical absolute URL path prefix.')
  }
  for (const segment of publicPath.split('/').filter(Boolean)) {
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      fail('INVALID_IMAGE_CONFIG', 'publicPath must contain valid URL-encoded segments.')
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      fail('INVALID_IMAGE_CONFIG', 'publicPath must not contain encoded traversal or separators.')
    }
  }
  const normalized = publicPath.length > 1 ? publicPath.replace(/\/+$/, '') : publicPath
  return normalized || '/'
}

/** Validate the shared options and normalize local paths to absolute paths. */
export function resolveImageVariantsConfig(options, { baseDir = process.cwd() } = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !CONFIG_KEYS.includes(key)) ||
      !Object.hasOwn(options, 'manifest') || !Object.hasOwn(options, 'sourceRoot') || !Object.hasOwn(options, 'outputDir')) {
    fail('INVALID_IMAGE_CONFIG', 'Image variants config requires manifest, sourceRoot, and outputDir only.')
  }
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
    fail('INVALID_IMAGE_CONFIG', 'The image variants config base directory must be absolute.')
  }

  const manifest = validateImageVariantsManifest(options.manifest)
  const sourceRoot = resolveDirectory(options.sourceRoot, 'sourceRoot', baseDir)
  const outputDir = resolveDirectory(options.outputDir, 'outputDir', baseDir)
  const publicPath = validatePublicPath(options.publicPath ?? '/variants')

  return Object.freeze({ manifest, sourceRoot, outputDir, publicPath })
}

/** Load a JSON config; relative paths resolve against baseDir or the file's directory. */
export async function loadImageVariantsConfig(configFile, { baseDir } = {}) {
  if (typeof configFile !== 'string' || configFile.length === 0) {
    fail('INVALID_IMAGE_CONFIG_FILE', 'A JSON image variants config file path is required.')
  }
  const absoluteFile = path.resolve(configFile)
  let parsed
  try {
    parsed = JSON.parse(await readFile(absoluteFile, 'utf8'))
  } catch (error) {
    fail('INVALID_IMAGE_CONFIG_FILE', `Could not read JSON image variants config: ${absoluteFile}`, error)
  }
  return resolveImageVariantsConfig(parsed, { baseDir: baseDir ?? path.dirname(absoluteFile) })
}
