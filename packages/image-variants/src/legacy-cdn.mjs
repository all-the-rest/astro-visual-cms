import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { publishStagedOverwrites } from './legacy-cdn-internal.mjs'

const MAX_IMAGES = 16
const MAX_VARIANTS_PER_IMAGE = 8
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024
const FULL_HASH_PATTERN = /^[a-f0-9]{64}$/
const TRANSFORM_NAMESPACE_PATTERN = /^v1-webp-q82-e4__sharp-[A-Za-z0-9._-]+__vips-[A-Za-z0-9._-]+$/
const LEGACY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  throw error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function validatePublicPath(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/') || publicPath.length === 0 ||
      publicPath.includes('\\') || publicPath.includes('\0') || publicPath.includes('?') || publicPath.includes('#') ||
      /\s/u.test(publicPath) || publicPath.includes('//') ||
      (publicPath.length > 1 && publicPath.endsWith('/')) ||
      publicPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('INVALID_LEGACY_OPTIONS', 'publicPath must be a canonical absolute V1 URL path prefix.')
  }
  for (const segment of publicPath.split('/').filter(Boolean)) {
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      fail('INVALID_LEGACY_OPTIONS', 'publicPath must contain valid URL-encoded segments.')
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      fail('INVALID_LEGACY_OPTIONS', 'publicPath must not contain encoded traversal or separators.')
    }
  }
  return publicPath
}

function validateGenerated(generated) {
  if (typeof generated !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generated)) {
    fail('INVALID_LEGACY_OPTIONS', 'generated must be an ISO-8601 UTC timestamp with millisecond precision.')
  }
  const date = new Date(generated)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== generated) {
    fail('INVALID_LEGACY_OPTIONS', 'generated must be a valid ISO-8601 UTC timestamp.')
  }
  return generated
}

function validateBaseUrl(baseUrl) {
  if (baseUrl === undefined) return undefined
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl !== baseUrl.trim() || /[\s\u0000-\u001f]/u.test(baseUrl)) {
    fail('INVALID_LEGACY_OPTIONS', 'baseUrl must be a canonical HTTP(S) origin without a path.')
  }
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail('INVALID_LEGACY_OPTIONS', 'baseUrl must be a canonical HTTP(S) origin without a path.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== baseUrl) {
    fail('INVALID_LEGACY_OPTIONS', 'baseUrl must be a canonical HTTP(S) origin without credentials, path, query, or fragment.')
  }
  return parsed.origin
}

function validateProjectionOptions(options) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !['baseUrl', 'generated', 'publicPath'].includes(key)) ||
      !Object.hasOwn(options, 'publicPath') || !Object.hasOwn(options, 'generated')) {
    fail('INVALID_LEGACY_OPTIONS', 'Legacy projection requires publicPath and generated, with optional baseUrl only.')
  }
  return {
    publicPath: validatePublicPath(options.publicPath),
    generated: validateGenerated(options.generated),
    baseUrl: validateBaseUrl(options.baseUrl),
  }
}

function validateV1Result(result, options) {
  if (!isPlainObject(result) || !hasExactKeys(result, ['version', 'transformNamespace', 'images']) || result.version !== 1 ||
      typeof result.transformNamespace !== 'string' || !TRANSFORM_NAMESPACE_PATTERN.test(result.transformNamespace) ||
      !Array.isArray(result.images) || result.images.length < 1 || result.images.length > MAX_IMAGES) {
    fail('INVALID_LEGACY_RESULT', 'Expected a valid V1 image-variants result.')
  }

  const namespace = result.transformNamespace
  const slugSet = new Set()
  const pathSet = new Set()
  const truncationToFullHash = new Map()
  const images = []
  const artifacts = []
  const publicPrefix = resultPublicPrefix(options)

  for (const [imageIndex, image] of result.images.entries()) {
    if (!isPlainObject(image) || !hasExactKeys(image, ['slug', 'width', 'height', 'variants']) ||
        typeof image.slug !== 'string' || !LEGACY_SLUG_PATTERN.test(image.slug) ||
        !Number.isSafeInteger(image.width) || image.width < 1 ||
        !Number.isSafeInteger(image.height) || image.height < 1 ||
        !Array.isArray(image.variants) || image.variants.length < 1 || image.variants.length > MAX_VARIANTS_PER_IMAGE) {
      fail('INVALID_LEGACY_RESULT', `V1 image ${imageIndex} has an invalid shape.`)
    }
    if (slugSet.has(image.slug)) fail('DUPLICATE_LEGACY_SLUG', 'The V1 result contains a duplicate image slug.')
    slugSet.add(image.slug)

    let imageHash
    let previousWidth = 0
    const variants = []
    for (const [variantIndex, variant] of image.variants.entries()) {
      if (!isPlainObject(variant) || !hasExactKeys(variant, ['url', 'format', 'width', 'height']) ||
          variant.format !== 'webp' || !Number.isSafeInteger(variant.width) || variant.width < 1 ||
          variant.width <= previousWidth || variant.width > image.width ||
          !Number.isSafeInteger(variant.height) || variant.height < 1 ||
          variant.height !== Math.round(image.height * variant.width / image.width) || typeof variant.url !== 'string') {
        fail('INVALID_LEGACY_RESULT', `V1 image ${image.slug} variant ${variantIndex} has an invalid shape.`)
      }

      const pathPrefix = `${publicPrefix}/${namespace}/`
      if (!variant.url.startsWith(pathPrefix)) {
        fail('INVALID_LEGACY_URL', `V1 image ${image.slug} has a URL outside its configured publicPath and transform namespace.`)
      }
      const match = /^([a-f0-9]{2})\/([a-f0-9]{64})_(0|[1-9]\d*)\.webp$/.exec(variant.url.slice(pathPrefix.length))
      if (!match) fail('INVALID_LEGACY_URL', `V1 image ${image.slug} has a malformed variant URL.`)
      const [, prefix, fullHash, urlWidth] = match
      if (!FULL_HASH_PATTERN.test(fullHash) || fullHash.slice(0, 2) !== prefix || String(variant.width) !== urlWidth) {
        fail('INVALID_LEGACY_URL', `V1 image ${image.slug} variant URL does not match its hash or width metadata.`)
      }
      const legacyHash = fullHash.slice(0, 16)
      const existingFullHash = truncationToFullHash.get(legacyHash)
      if (existingFullHash !== undefined && existingFullHash !== fullHash) {
        fail('LEGACY_HASH_COLLISION', `Distinct full SHA-256 hashes share legacy hash ${legacyHash}.`)
      }
      truncationToFullHash.set(legacyHash, fullHash)

      if (imageHash !== undefined && imageHash !== fullHash) {
        fail('MIXED_LEGACY_SOURCE_HASHES', `V1 image ${image.slug} uses different source hashes across widths.`)
      }
      imageHash = fullHash
      previousWidth = variant.width

      const objectKey = `${legacyHash.slice(0, 2)}/${legacyHash}_${variant.width}.webp`
      if (pathSet.has(objectKey)) {
        fail('DUPLICATE_LEGACY_PATH', `More than one V1 variant maps to legacy object key ${objectKey}.`)
      }
      pathSet.add(objectKey)
      const sourceRelativePath = `${namespace}/${prefix}/${fullHash}_${variant.width}.webp`
      const url = `${options.baseUrl ?? ''}/${objectKey}`
      artifacts.push(Object.freeze({
        slug: image.slug,
        width: variant.width,
        url,
        objectKey,
        sourceRelativePath,
      }))
      variants.push(variant.width)
    }

    images.push([image.slug, Object.freeze({
      hash: imageHash.slice(0, 16),
      width: image.width,
      height: image.height,
      variants: Object.freeze(variants),
    })])
  }

  const manifest = Object.freeze({
    version: 1,
    generated: options.generated,
    images: Object.freeze(Object.fromEntries(images)),
  })
  return Object.freeze({ manifest, artifacts: Object.freeze(artifacts) })
}

// The public projection API keeps timestamp and URL configuration explicit and deterministic.
export function projectLegacyManifest(result, options) {
  const validatedOptions = validateProjectionOptions(options)
  return publicProjection(projectValidatedResult(result, validatedOptions))
}

function projectValidatedResult(result, options) {
  // Keep the deeply validated V1 result parser independent of caller-controlled URL prefixes.
  return validateV1Result(result, options)
}

function publicProjection(projection) {
  return Object.freeze({
    manifest: projection.manifest,
    artifacts: Object.freeze(projection.artifacts.map(({ slug, width, url, objectKey }) => Object.freeze({
      slug,
      width,
      url,
      objectKey,
    }))),
  })
}

function resultPublicPrefix(options) {
  return options.publicPath === '/' ? '' : options.publicPath
}

function resolveFilesystemPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('INVALID_LEGACY_OPTIONS', `${label} must be a non-empty filesystem path.`)
  }
  try {
    return path.resolve(value)
  } catch (error) {
    fail('INVALID_LEGACY_OPTIONS', `${label} must be a valid filesystem path.`, error)
  }
}

async function trustedDirectory(candidate, label, { create = false } = {}) {
  const absolute = resolveFilesystemPath(candidate, label)
  const parsed = path.parse(absolute)
  if (absolute === parsed.root) fail(`${label}_UNAVAILABLE`, `${label} must not be a filesystem root.`)
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
      if (stat.isSymbolicLink()) fail(`${label}_SYMLINK`, `${label} must not contain symbolic links.`)
      if (!stat.isDirectory()) fail(`${label}_NOT_DIRECTORY`, `${label} contains a non-directory component.`)
    }
    return await realpath(absolute)
  } catch (error) {
    if (error.code?.startsWith(`${label}_`)) throw error
    fail(`${label}_UNAVAILABLE`, `${label} is unavailable.`, error)
  }
}

async function ensureRelativeDirectory(root, segments, label, { create = false } = {}) {
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) fail(`${label}_UNAVAILABLE`, `${label} directory is unavailable.`, error)
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') fail(`${label}_UNAVAILABLE`, `${label} directory could not be created.`, mkdirError)
      }
      try {
        stat = await lstat(current)
      } catch (statError) {
        fail(`${label}_UNAVAILABLE`, `${label} directory could not be inspected.`, statError)
      }
    }
    if (stat.isSymbolicLink()) fail(`${label}_SYMLINK`, `${label} directories must not be symbolic links.`)
    if (!stat.isDirectory()) fail(`${label}_NOT_DIRECTORY`, `${label} path contains a non-directory component.`)
  }
  return current
}

async function readExpectedSource(root, relativePath, budget) {
  const segments = relativePath.split('/')
  const filename = segments.pop()
  const directory = await ensureRelativeDirectory(root, segments, 'LEGACY_SOURCE', { create: false })
  const candidate = path.join(directory, filename)
  let before
  try {
    before = await lstat(candidate)
  } catch (error) {
    fail('LEGACY_SOURCE_UNAVAILABLE', 'An expected V1 variant file is unavailable.', error)
  }
  if (before.isSymbolicLink()) fail('LEGACY_SOURCE_SYMLINK', 'Expected V1 variant files must not be symbolic links.')
  if (!before.isFile()) fail('LEGACY_SOURCE_NOT_FILE', 'An expected V1 variant is not a regular file.')
  if (before.size < 1 || before.size > MAX_ARTIFACT_BYTES || budget.bytes + before.size > MAX_TOTAL_ARTIFACT_BYTES) {
    fail('LEGACY_ARTIFACT_LIMIT', 'Expected V1 variants exceed the safe per-file or total copy size limit.')
  }

  let handle
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error.code === 'ELOOP') fail('LEGACY_SOURCE_SYMLINK', 'Expected V1 variant files must not be symbolic links.')
    fail('LEGACY_SOURCE_UNAVAILABLE', 'An expected V1 variant file could not be opened.', error)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) fail('LEGACY_SOURCE_NOT_FILE', 'An expected V1 variant is not a regular file.')
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('LEGACY_SOURCE_CHANGED', 'An expected V1 variant changed while it was being opened.')
    }
    if (opened.size < 1 || opened.size > MAX_ARTIFACT_BYTES || budget.bytes + opened.size > MAX_TOTAL_ARTIFACT_BYTES) {
      fail('LEGACY_ARTIFACT_LIMIT', 'Expected V1 variants exceed the safe per-file or total copy size limit.')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) fail('LEGACY_SOURCE_CHANGED', 'An expected V1 variant changed while it was being read.')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('LEGACY_SOURCE_CHANGED', 'An expected V1 variant changed while it was being read.')
    }
    budget.bytes += bytes.length
    return bytes
  } finally {
    await handle.close()
  }
}

async function inspectDestination(filename, overwrite) {
  let stat
  try {
    stat = await lstat(filename)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    fail('LEGACY_OUTPUT_UNAVAILABLE', 'A legacy output path could not be inspected.', error)
  }
  if (stat.isSymbolicLink()) fail('LEGACY_OUTPUT_SYMLINK', 'Legacy output files must not be symbolic links.')
  if (!stat.isFile()) fail('LEGACY_OUTPUT_NOT_FILE', 'A legacy output key is not a regular file.')
  if (!overwrite) fail('LEGACY_ARTIFACT_EXISTS', 'A legacy object already exists; pass overwrite: true to replace it deliberately.')
  return true
}

/** Copy validated V1 variant files to mutable, truncated-hash legacy CDN keys. */
export async function writeLegacyVariantArtifacts(result, options) {
  if (!isPlainObject(options) || Object.keys(options).some((key) =>
    !['baseUrl', 'generated', 'outputDir', 'overwrite', 'publicPath', 'sourceDir'].includes(key)) ||
      !Object.hasOwn(options, 'outputDir') || !Object.hasOwn(options, 'sourceDir') ||
      typeof options.overwrite !== 'undefined' && typeof options.overwrite !== 'boolean') {
    fail('INVALID_LEGACY_OPTIONS', 'Legacy writing requires sourceDir and outputDir, plus projection options and optional boolean overwrite.')
  }
  const projectionOptions = {
    publicPath: options.publicPath,
    generated: options.generated,
    ...(Object.hasOwn(options, 'baseUrl') ? { baseUrl: options.baseUrl } : {}),
  }
  const validatedProjectionOptions = validateProjectionOptions(projectionOptions)
  const internalProjection = projectValidatedResult(result, validatedProjectionOptions)
  const projected = publicProjection(internalProjection)

  // Validate every expected source before creating output paths or publishing any key.
  const sourceRoot = await trustedDirectory(options.sourceDir, 'LEGACY_SOURCE_ROOT')
  const prepared = []
  const budget = { bytes: 0 }
  for (const artifact of internalProjection.artifacts) {
    const bytes = await readExpectedSource(sourceRoot, artifact.sourceRelativePath, budget)
    prepared.push({ ...artifact, bytes })
  }

  const outputRoot = await trustedDirectory(options.outputDir, 'LEGACY_OUTPUT_ROOT', { create: true })
  const destinations = []
  for (const item of prepared) {
    const segments = item.objectKey.split('/')
    const filename = segments.pop()
    const directory = await ensureRelativeDirectory(outputRoot, segments, 'LEGACY_OUTPUT', { create: true })
    const outputPath = path.join(directory, filename)
    await inspectDestination(outputPath, options.overwrite === true)
    destinations.push({ ...item, outputPath, directory })
  }

  const staged = []
  try {
    for (const destination of destinations) {
      const tempPath = path.join(destination.directory, `.legacy-variant-${randomUUID()}.tmp`)
      staged.push({ ...destination, tempPath })
      try {
        await writeFile(tempPath, destination.bytes, { flag: 'wx', mode: 0o644 })
      } catch (error) {
        fail('LEGACY_OUTPUT_WRITE_FAILED', 'A same-directory legacy staging file could not be written.', error)
      }
    }

    let invalidationUrls = []
    if (options.overwrite === true) {
      invalidationUrls = await publishStagedOverwrites(staged, async (item) => {
        await ensureRelativeDirectory(outputRoot, item.objectKey.split('/').slice(0, -1), 'LEGACY_OUTPUT', { create: false })
        await inspectDestination(item.outputPath, true)
        try {
          await rename(item.tempPath, item.outputPath)
        } catch (error) {
          fail('LEGACY_OUTPUT_WRITE_FAILED', 'A staged legacy variant could not be atomically published.', error)
        }
      })
    } else {
      for (const item of staged) {
        await ensureRelativeDirectory(outputRoot, item.objectKey.split('/').slice(0, -1), 'LEGACY_OUTPUT', { create: false })
        try {
          await link(item.tempPath, item.outputPath)
        } catch (error) {
          if (error.code === 'EEXIST') {
            await inspectDestination(item.outputPath, false)
          }
          fail('LEGACY_OUTPUT_WRITE_FAILED', 'A staged legacy variant could not be published without replacement.', error)
        }
        await rm(item.tempPath)
      }
    }

    return Object.freeze({
      manifest: projected.manifest,
      artifacts: projected.artifacts,
      invalidationUrls: Object.freeze(invalidationUrls),
    })
  } finally {
    for (const item of staged) {
      try {
        await rm(item.tempPath, { force: true })
      } catch {
        // A published file has already been atomically moved/linked; cleanup is best-effort.
      }
    }
  }
}
