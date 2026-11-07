import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_MANIFEST_ENTRIES = 16
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_PIXELS = 10_000_000
const MAX_VARIANTS = 8
const MAX_VARIANT_WIDTH = 8192
const MANIFEST_KEYS = ['file', 'format', 'maxBytes', 'maxPixels', 'slug', 'widths']

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
      !/^[a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg)$/.test(entry.file) ||
      path.posix.basename(entry.file) !== entry.file || path.win32.basename(entry.file) !== entry.file) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must name one local JPEG file.`)
  }
  if (entry.format !== 'jpeg' || !['.jpg', '.jpeg'].includes(path.extname(entry.file))) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} must declare JPEG input.`)
  }
  if (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > MAX_SOURCE_BYTES ||
      !Number.isSafeInteger(entry.maxPixels) || entry.maxPixels < 1 || entry.maxPixels > MAX_IMAGE_PIXELS) {
    fail('INVALID_IMAGE_MANIFEST', `Image manifest entry ${index} has invalid size limits.`)
  }
  if (!Array.isArray(entry.widths) || entry.widths.length < 1 || entry.widths.length > MAX_VARIANTS ||
      entry.widths.some((width, widthIndex) => !Number.isSafeInteger(width) || width < 1 || width > MAX_VARIANT_WIDTH ||
        (widthIndex > 0 && width <= entry.widths[widthIndex - 1]))) {
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

/** Validate the deliberately small, technical-only source manifest. */
export function validateStaticImageManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > MAX_MANIFEST_ENTRIES) {
    fail('INVALID_IMAGE_MANIFEST', 'The image manifest must contain a bounded, non-empty list.')
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

async function canonicalDirectory(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.split(path.sep).includes('..')) {
    fail(`${label}_UNAVAILABLE`, `The trusted ${label.toLowerCase()} directory is unavailable.`)
  }

  const absolute = path.resolve(candidate)
  const parsed = path.parse(absolute)
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  try {
    for (const component of components) {
      current = path.join(current, component)
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) fail(`${label}_SYMLINK`, `The trusted ${label.toLowerCase()} path must not contain symbolic links.`)
      if (!stat.isDirectory()) fail(`${label}_NOT_DIRECTORY`, `The trusted ${label.toLowerCase()} path contains a non-directory component.`)
    }
    return await realpath(absolute)
  } catch (error) {
    if (error.code?.startsWith(`${label}_`)) throw error
    fail(`${label}_UNAVAILABLE`, `The trusted ${label.toLowerCase()} directory is unavailable.`)
  }
}

async function readBoundedJpeg(entry, imageRoot) {
  const candidate = path.join(imageRoot, entry.file)
  let before
  try {
    before = await lstat(candidate)
  } catch {
    fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
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
  if (!isWithinDirectory(imageRoot, canonical)) fail('IMAGE_SOURCE_ESCAPE', 'The image source resolves outside its trusted directory.')

  let handle
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    fail('IMAGE_SOURCE_UNAVAILABLE', 'The trusted image source is unavailable.')
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
    bytes = Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }

  let metadata
  try {
    metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  } catch {
    fail('INVALID_IMAGE', 'The trusted image source is not a readable JPEG.')
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

async function ensureVariantsDirectory(publicRoot) {
  const canonicalPublicRoot = await canonicalDirectory(publicRoot, 'PUBLIC_ROOT')
  const variantsDirectory = path.join(canonicalPublicRoot, 'variants')
  try {
    const stat = await lstat(variantsDirectory)
    if (stat.isSymbolicLink()) fail('VARIANT_DIRECTORY_SYMLINK', 'The generated variant directory must not be a symbolic link.')
    if (!stat.isDirectory()) fail('VARIANT_DIRECTORY_NOT_DIRECTORY', 'The generated variant path is not a directory.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await mkdir(variantsDirectory)
  }
  const canonicalVariantsDirectory = await realpath(variantsDirectory)
  if (!isWithinDirectory(canonicalPublicRoot, canonicalVariantsDirectory)) {
    fail('VARIANT_DIRECTORY_ESCAPE', 'The generated variant directory escapes the public root.')
  }
  return canonicalVariantsDirectory
}

/** Read validated JPEGs and write deterministic, content-addressed static WebP variants. */
export async function generateStaticVariants({ manifest, imageRoot, publicRoot }) {
  const entries = validateStaticImageManifest(manifest)
  const canonicalImageRoot = await canonicalDirectory(imageRoot, 'IMAGE_ROOT')
  const variantsDirectory = await ensureVariantsDirectory(publicRoot)
  const images = []

  for (const entry of entries) {
    const { bytes, metadata } = await readBoundedJpeg(entry, canonicalImageRoot)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const variants = []
    for (const width of entry.widths) {
      const output = await sharp(bytes, { limitInputPixels: entry.maxPixels })
        .resize({ width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer()
      const outputMetadata = await sharp(output).metadata()
      if (outputMetadata.format !== 'webp' || !outputMetadata.width || !outputMetadata.height || outputMetadata.width !== width) {
        fail('VARIANT_GENERATION_FAILED', 'Sharp did not produce the expected WebP dimensions.')
      }

      const filename = `${entry.slug}-${contentHash}-${width}.webp`
      const outputPath = path.join(variantsDirectory, filename)
      try {
        await writeFile(outputPath, output, { flag: 'wx' })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await readFile(outputPath)
        if (!existing.equals(output)) fail('VARIANT_CONTENT_COLLISION', 'A content-addressed variant path already contains different bytes.')
      }
      variants.push({ url: `/variants/${filename}`, width: outputMetadata.width, height: outputMetadata.height })
    }
    images.push({ slug: entry.slug, width: metadata.width, height: metadata.height, variants })
  }

  return Object.freeze({ images: Object.freeze(images) })
}

function sourceNameMatches(source, sourceFiles) {
  if (typeof source !== 'string') return false
  const candidates = [source.replace(/[?#].*$/, '')]
  try {
    candidates.push(decodeURIComponent(candidates[0]))
  } catch {
    // Invalid URI escapes cannot identify one of the manifest files.
  }
  return candidates.some((candidate) => {
    const normalized = candidate.replaceAll('\\', '/')
    return sourceFiles.has(normalized.slice(normalized.lastIndexOf('/') + 1).toLocaleLowerCase('en-US'))
  })
}

/** Vite guard for source JPEGs; generated public WebP files are intentionally not imports. */
export function createSourceJpegImportGuard(manifest) {
  const files = new Set(validateStaticImageManifest(manifest).map(({ file }) => file.toLocaleLowerCase('en-US')))
  return {
    name: 'synthetic-source-jpeg-import-guard',
    enforce: 'pre',
    resolveId(source) {
      if (sourceNameMatches(source, files)) {
        throw new Error('Synthetic source JPEGs must be transformed at build time, not resolved as Vite image modules.')
      }
    },
    buildStart() {
      for (const file of files) {
        if (!sourceNameMatches(file, files)) this.error('Synthetic source JPEG import guard self-check failed.')
      }
      console.log(`Synthetic JPEG Vite import guard active for ${files.size} source files.`)
    },
  }
}
