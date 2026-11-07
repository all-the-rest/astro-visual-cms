import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { FIXTURE_IMAGE_SLUGS } from './gallery-patch.mjs'

const PROJECT_ROOT = process.cwd()
const IMAGE_ROOT = await realpath(path.join(PROJECT_ROOT, 'public/images'))
const imageFileBySlug = new Map(FIXTURE_IMAGE_SLUGS.map((slug) => [slug, `${slug}.jpg`]))

/**
 * Resolve only the spike's fixed local slugs. The hidden fsPath property matches
 * Astro's imported-image metadata shape, but is resolved from disk rather than
 * emitted as a Vite image-module import.
 */
export async function resolveFixtureImageMetadata(slug) {
  if (!imageFileBySlug.has(slug)) throw new Error(`Unknown fixture image slug: ${String(slug)}`)

  const candidate = await realpath(path.join(IMAGE_ROOT, imageFileBySlug.get(slug)))
  if (!candidate.startsWith(`${IMAGE_ROOT}${path.sep}`)) throw new Error('Fixture image escaped the local image directory.')
  const bytes = await readFile(candidate)
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const metadata = await sharp(bytes).metadata()
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) {
    throw new Error(`Fixture image ${slug} is not a readable JPEG.`)
  }

  const image = {
    src: `/images/${imageFileBySlug.get(slug)}?content=${contentHash}`,
    width: metadata.width,
    height: metadata.height,
    format: 'jpeg',
  }
  Object.defineProperty(image, 'fsPath', { value: candidate, enumerable: false })
  return image
}
