import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { FIXTURE_IMAGE_SLUGS } from '../src/lib/gallery-patch.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SLUG = FIXTURE_IMAGE_SLUGS[0]
const SOURCE_PATH = path.join(ROOT, `public/images/${SLUG}.jpg`)
const OUTPUT_DIR = path.join(ROOT, 'dist/images')

function runBuild(label) {
  console.log(`\n--- Astro build: ${label} ---`)
  const build = spawnSync('pnpm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' })
  if (build.stdout) process.stdout.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Astro build failed (${label}, exit ${build.status ?? 'unknown'}).`)
  return `${build.stdout || ''}\n${build.stderr || ''}`
}

function findOptimizedImage(slug) {
  const files = readdirSync(OUTPUT_DIR).filter((file) => file.startsWith(`${slug}_`) && file.endsWith('.webp'))
  assert.equal(files.length, 1, `Expected one optimized WebP for ${slug}; got ${files.join(', ')}`)
  return files[0]
}

async function decodedPixels(imagePath) {
  return sharp(imagePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
}

function countChangedPixels(first, second) {
  assert.equal(first.info.width, second.info.width)
  assert.equal(first.info.height, second.info.height)
  assert.equal(first.info.channels, 3)
  assert.equal(second.info.channels, 3)
  let changed = 0
  for (let index = 0; index < first.data.length; index += 3) {
    const distance = Math.abs(first.data[index] - second.data[index]) +
      Math.abs(first.data[index + 1] - second.data[index + 1]) +
      Math.abs(first.data[index + 2] - second.data[index + 2])
    if (distance >= 24) changed += 1
  }
  return changed
}

const htmlPath = path.join(ROOT, 'dist/fixture/index.html')
const firstSource = readFileSync(SOURCE_PATH)
const firstSourceHash = createHash('sha256').update(firstSource).digest('hex')
const firstSourcePixels = await decodedPixels(SOURCE_PATH)
const firstBuildLog = runBuild('baseline source')
assert.ok(existsSync(htmlPath), 'Astro must emit the rendered MDX fixture.')
const firstHtml = readFileSync(htmlPath, 'utf8')
const firstOutput = findOptimizedImage(SLUG)
assert.match(firstHtml, new RegExp(`${SLUG}_[^" ]+\\.webp`))
const firstOutputPixels = await decodedPixels(path.join(OUTPUT_DIR, firstOutput))
const firstOutputImageNames = new Map(FIXTURE_IMAGE_SLUGS.map((slug) => [slug, findOptimizedImage(slug)]))

const inversePixels = Buffer.allocUnsafe(firstSourcePixels.data.length)
for (let index = 0; index < firstSourcePixels.data.length; index += 1) {
  inversePixels[index] = 255 - firstSourcePixels.data[index]
}
const alternateJpeg = await sharp(inversePixels, {
  raw: {
    width: firstSourcePixels.info.width,
    height: firstSourcePixels.info.height,
    channels: firstSourcePixels.info.channels,
  },
}).jpeg({ quality: 82, chromaSubsampling: '4:4:4' }).toBuffer()
const secondSourceHash = createHash('sha256').update(alternateJpeg).digest('hex')
let secondOutput
let secondSourcePixelChanges
let secondOutputPixelChanges

try {
  writeFileSync(SOURCE_PATH, alternateJpeg)
  assert.notEqual(secondSourceHash, firstSourceHash, 'The two builds must use different JPEG source bytes.')
  const secondSourcePixels = await decodedPixels(SOURCE_PATH)
  secondSourcePixelChanges = countChangedPixels(firstSourcePixels, secondSourcePixels)
  assert.ok(secondSourcePixelChanges > 10_000, 'The second JPEG must contain different decoded pixels.')

  const secondBuildLog = runBuild('alternate pixels, same slug')
  const secondHtml = readFileSync(htmlPath, 'utf8')
  secondOutput = findOptimizedImage(SLUG)
  const secondOutputPixels = await decodedPixels(path.join(OUTPUT_DIR, secondOutput))
  assert.notEqual(firstOutput, secondOutput, 'Content changes for one slug must change Astro’s optimized output name.')
  secondOutputPixelChanges = countChangedPixels(firstOutputPixels, secondOutputPixels)
  assert.ok(secondOutputPixelChanges > 10_000, 'The second build must emit different WebP pixels, not a stale cached image.')

  assert.match(secondHtml, new RegExp(`${SLUG}_[^" ]+\\.webp`))
  assert.match(secondBuildLog, new RegExp(`${SLUG}_[^\\s]+\\.webp`))
  for (const slug of FIXTURE_IMAGE_SLUGS) {
    const file = findOptimizedImage(slug)
    assert.match(secondHtml, new RegExp(`${slug}_[^" ]+\\.webp`), `Rendered HTML must reference optimized output for ${slug}.`)
    if (slug !== SLUG) assert.equal(file, firstOutputImageNames.get(slug), `Unchanged source for ${slug} should remain stable.`)
  }
} finally {
  writeFileSync(SOURCE_PATH, firstSource)
}

const restoredBuildLog = runBuild('restored source')
const restoredOutput = findOptimizedImage(SLUG)
const restoredOutputPixels = await decodedPixels(path.join(OUTPUT_DIR, restoredOutput))
assert.equal(restoredOutput, firstOutput, 'Restoring the first source must restore its content-addressed output name.')
assert.equal(countChangedPixels(firstOutputPixels, restoredOutputPixels), 0, 'The restored build must reproduce the first output pixels.')
assert.match(restoredBuildLog, new RegExp(`${SLUG}_[^\\s]+\\.webp`))

const finalHtml = readFileSync(htmlPath, 'utf8')
const optimizedImages = readdirSync(OUTPUT_DIR).filter((file) => file.endsWith('.webp'))
assert.equal(optimizedImages.length, FIXTURE_IMAGE_SLUGS.length, 'Each slug must be emitted as an optimized WebP.')
for (const slug of FIXTURE_IMAGE_SLUGS) {
  const file = findOptimizedImage(slug)
  assert.match(finalHtml, new RegExp(`${slug}_[^" ]+\\.webp`), `Rendered HTML must reference optimized output for ${slug}.`)
  if (slug !== SLUG) assert.equal(file, firstOutputImageNames.get(slug), `Unchanged source for ${slug} should remain stable.`)
}
console.log(`Verified same slug with two sources: ${firstSourceHash.slice(0, 12)} → ${secondSourceHash.slice(0, 12)}, ${secondSourcePixelChanges} JPEG pixels / ${secondOutputPixelChanges} WebP pixels changed. Source was restored; ${firstOutput} → ${secondOutput} → ${restoredOutput}. The Vite import guard remained active.`)
