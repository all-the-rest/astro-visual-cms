import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rmdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { SOURCE_MANIFEST } from '../fixtures/sharp-build/source-manifest.mjs'
import { generateStaticVariants } from './sharp-static-variants.mjs'

const APP_ROOT = fileURLToPath(new URL('../fixtures/sharp-build/', import.meta.url))
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const WIDTH = 320
const HEIGHT = 180
const CHANNELS = 3

function deterministicNoise(slug, phase) {
  const seed = createHash('sha256').update(`${slug}:${phase}`).digest()
  let state = seed.readUInt32LE(0) || 1
  const pixels = Buffer.allocUnsafe(WIDTH * HEIGHT * CHANNELS)
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    pixels[index] = state >>> 24
  }
  return pixels
}

async function createSyntheticJpeg(slug, phase = 'baseline') {
  return sharp(deterministicNoise(slug, phase), {
    raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS },
  }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
}

async function walkFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in synthetic build output: ${fullPath}`)
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
    else throw new Error(`Unexpected non-file in synthetic build output: ${fullPath}`)
  }
  return files
}

async function decodedImage(imagePath) {
  const { data, info } = await sharp(imagePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.channels, CHANNELS)
  return { data, width: info.width, height: info.height }
}

function changedPixelCount(first, second) {
  assert.equal(first.width, second.width)
  assert.equal(first.height, second.height)
  let changed = 0
  for (let index = 0; index < first.data.length; index += CHANNELS) {
    const distance = Math.abs(first.data[index] - second.data[index]) +
      Math.abs(first.data[index + 1] - second.data[index + 1]) +
      Math.abs(first.data[index + 2] - second.data[index + 2])
    if (distance >= 24) changed += 1
  }
  return changed
}

function expectedImage(manifest, slug) {
  const image = manifest.images.find((candidate) => candidate.slug === slug)
  assert.ok(image, `Missing generated manifest entry for ${slug}.`)
  return image
}

async function runAstroBuild({ label, scratch, imageRoot, buildNumber }) {
  const appRoot = path.join(scratch, `app-${buildNumber}`)
  const publicRoot = path.join(scratch, `public-${buildNumber}`)
  const outDir = path.join(scratch, `dist-${buildNumber}`)
  const cacheDir = path.join(scratch, `cache-${buildNumber}`)
  await Promise.all([mkdir(appRoot), mkdir(publicRoot), mkdir(outDir), mkdir(cacheDir)])
  await cp(path.join(APP_ROOT, 'src'), path.join(appRoot, 'src'), { recursive: true })
  await symlink(path.join(REPOSITORY_ROOT, 'node_modules'), path.join(appRoot, 'node_modules'), 'dir')

  const manifest = await generateStaticVariants({ manifest: SOURCE_MANIFEST, imageRoot, publicRoot })
  const manifestPath = path.join(scratch, `variant-manifest-${buildNumber}.json`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })

  console.log(`\n--- Synthetic Astro production build: ${label} ---`)
  const build = spawnSync('pnpm', ['exec', 'astro', 'build'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHARP_TEST_APP_ROOT: appRoot,
      SHARP_TEST_PUBLIC_DIR: publicRoot,
      SHARP_TEST_OUT_DIR: outDir,
      SHARP_TEST_CACHE_DIR: cacheDir,
      SHARP_TEST_VARIANT_MANIFEST: manifestPath,
    },
  })
  if (build.stdout) process.stdout.write(build.stdout)
  if (build.stderr) process.stderr.write(build.stderr)
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Synthetic Astro build failed (${label}, exit ${build.status ?? 'unknown'}).`)
  const buildLog = `${build.stdout || ''}\n${build.stderr || ''}`
  assert.match(buildLog, /Synthetic JPEG Vite import guard active for 2 source files\./)

  return { manifest, manifestPath, publicRoot, outDir, buildLog }
}

async function verifyBuildArtifacts(build, sourceRoot) {
  const htmlPath = path.join(build.outDir, 'index.html')
  const html = await readFile(htmlPath, 'utf8')
  const sourceTags = [...html.matchAll(/<source\b[^>]*>/g)].map(([tag]) => tag)
  assert.equal(sourceTags.length, SOURCE_MANIFEST.length, 'Each synthetic image must have one responsive WebP source.')

  const expectedFiles = new Set()
  const decodedVariants = new Map()
  for (let index = 0; index < SOURCE_MANIFEST.length; index += 1) {
    const source = SOURCE_MANIFEST[index]
    const image = expectedImage(build.manifest, source.slug)
    const sourceTag = sourceTags[index]
    assert.match(sourceTag, /type="image\/webp"/)
    const srcsetMatch = sourceTag.match(/srcset="([^"]+)"/)
    assert.ok(srcsetMatch, `${source.slug} must expose a static srcset.`)
    const srcset = image.variants.map(({ url, width }) => `${url} ${width}w`).join(', ')
    assert.equal(srcsetMatch[1], srcset)
    assert.match(sourceTag, /sizes="100vw"/)

    const alt = `Generated noise pattern ${index === 0 ? 'one' : 'two'}`
    assert.ok(html.includes(`alt="${alt}"`), 'Synthetic alt text belongs to the consuming page, not the shared pipeline.')
    const imgTag = [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag)[index]
    assert.ok(imgTag)
    assert.match(imgTag, new RegExp(`src="${image.variants.at(-1).url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
    assert.match(imgTag, new RegExp(`width="${image.width}"`))
    assert.match(imgTag, new RegExp(`height="${image.height}"`))

    for (const variant of image.variants) {
      assert.equal(variant.height, Math.round(image.height * variant.width / image.width))
      assert.match(variant.url, new RegExp(`^/variants/${source.slug}-[a-f0-9]{64}-${variant.width}\\.webp$`))
      const outputPath = path.join(build.outDir, variant.url.slice(1))
      const decoded = await decodedImage(outputPath)
      assert.deepEqual([decoded.width, decoded.height], [variant.width, variant.height])
      const metadata = await sharp(outputPath).metadata()
      assert.equal(metadata.format, 'webp')
      assert.ok(new Set(decoded.data).size > 32,
        'Decoded WebP output should contain the generated synthetic texture.')
      expectedFiles.add(path.resolve(outputPath))
      decodedVariants.set(variant.url, decoded)
    }
  }

  assert.doesNotMatch(html, /\.jpe?g(?:[?#" ]|$)/i, 'Rendered HTML must reference variants rather than source JPEGs.')
  const outputFiles = await walkFiles(build.outDir)
  assert.ok(outputFiles.length > 0)
  assert.ok(outputFiles.every((file) => !/\.jpe?g$/i.test(file)), 'Source JPEGs must not be copied into Astro output.')
  const outputWebps = outputFiles.filter((file) => file.endsWith('.webp')).map((file) => path.resolve(file)).sort()
  assert.deepEqual(outputWebps, [...expectedFiles].sort(), 'Astro must emit exactly the generated static WebP variants.')

  for (const source of SOURCE_MANIFEST) {
    const inputPath = path.join(sourceRoot, source.file)
    assert.ok(await lstat(inputPath))
  }
  return { html, decodedVariants, outputFiles }
}

async function main() {
  const fixtureAstroDirectory = path.join(APP_ROOT, '.astro')
  let fixtureAstroDirectoryExisted = false
  try {
    const stat = await lstat(fixtureAstroDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The fixture .astro path must be a real directory when present.')
    fixtureAstroDirectoryExisted = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const tempParent = await realpath(os.tmpdir())
  const scratch = await mkdtemp(path.join(tempParent, 'astro-sharp-build-proof-'))
  const canonicalScratch = await realpath(scratch)
  assert.equal(canonicalScratch, scratch, 'The owned temporary test workspace must not be a symlink.')
  const imageRoot = path.join(scratch, 'synthetic-input')
  await mkdir(imageRoot)
  const originalSources = new Map()
  let sourceToRestore
  let bytesToRestore

  try {
    for (const entry of SOURCE_MANIFEST) {
      const bytes = await createSyntheticJpeg(entry.slug)
      const sourcePath = path.join(imageRoot, entry.file)
      await writeFile(sourcePath, bytes, { flag: 'wx' })
      originalSources.set(entry.slug, bytes)
    }

    const firstBuild = await runAstroBuild({ label: 'baseline synthetic JPEGs', scratch, imageRoot, buildNumber: 1 })
    const firstArtifacts = await verifyBuildArtifacts(firstBuild, imageRoot)
    const firstOutputs = new Map()
    for (const image of firstBuild.manifest.images) {
      for (const variant of image.variants) {
        firstOutputs.set(variant.url, await readFile(path.join(firstBuild.outDir, variant.url.slice(1))))
      }
    }

    const changedSource = SOURCE_MANIFEST[0]
    sourceToRestore = path.join(imageRoot, changedSource.file)
    bytesToRestore = originalSources.get(changedSource.slug)
    const alternateBytes = await createSyntheticJpeg(changedSource.slug, 'alternate-pixels')
    await writeFile(sourceToRestore, alternateBytes)
    assert.notDeepEqual(alternateBytes, bytesToRestore, 'The invalidation build must use changed JPEG bytes.')
    const originalSourcePixels = await decodedImageFromBytes(bytesToRestore)
    const alternateSourcePixels = await decodedImageFromBytes(alternateBytes)
    const sourcePixelChanges = changedPixelCount(originalSourcePixels, alternateSourcePixels)
    assert.ok(sourcePixelChanges > WIDTH * HEIGHT * 0.5, 'The alternate synthetic JPEG must have substantially different source pixels.')

    const alternateBuild = await runAstroBuild({ label: 'same slug, changed synthetic pixels', scratch, imageRoot, buildNumber: 2 })
    const alternateArtifacts = await verifyBuildArtifacts(alternateBuild, imageRoot)
    const firstImage = expectedImage(firstBuild.manifest, changedSource.slug)
    const alternateImage = expectedImage(alternateBuild.manifest, changedSource.slug)
    let outputPixelChanges = 0
    for (let index = 0; index < firstImage.variants.length; index += 1) {
      const previous = firstImage.variants[index]
      const next = alternateImage.variants[index]
      assert.equal(previous.width, next.width)
      assert.notEqual(previous.url, next.url, 'Changed source pixels for one slug must change each content-addressed variant URL.')
      const before = firstArtifacts.decodedVariants.get(previous.url)
      const after = alternateArtifacts.decodedVariants.get(next.url)
      const changes = changedPixelCount(before, after)
      assert.ok(changes > previous.width * previous.height * 0.5, 'Changed source pixels must produce changed decoded WebP pixels.')
      if (previous.width === 320) outputPixelChanges = changes
    }

    const unchangedSlug = SOURCE_MANIFEST[1].slug
    const firstUnchanged = expectedImage(firstBuild.manifest, unchangedSlug)
    const alternateUnchanged = expectedImage(alternateBuild.manifest, unchangedSlug)
    assert.deepEqual(alternateUnchanged, firstUnchanged, 'Unchanged JPEG inputs must retain deterministic generated metadata.')
    for (const variant of firstUnchanged.variants) {
      assert.deepEqual(
        await readFile(path.join(alternateBuild.outDir, variant.url.slice(1))),
        firstOutputs.get(variant.url),
        'Unchanged JPEG inputs must produce byte-identical WebP output.',
      )
    }

    await writeFile(sourceToRestore, bytesToRestore)
    const restoredBytes = await readFile(sourceToRestore)
    assert.deepEqual(restoredBytes, bytesToRestore, 'The synthetic source JPEG must be restored byte-for-byte.')
    sourceToRestore = undefined
    const restoredBuild = await runAstroBuild({ label: 'restored baseline synthetic JPEGs', scratch, imageRoot, buildNumber: 3 })
    const restoredArtifacts = await verifyBuildArtifacts(restoredBuild, imageRoot)
    assert.deepEqual(restoredBuild.manifest, firstBuild.manifest)
    assert.equal(restoredArtifacts.html, firstArtifacts.html, 'Restoring the source must restore the exact static HTML.')
    for (const [url, bytes] of firstOutputs) {
      assert.deepEqual(await readFile(path.join(restoredBuild.outDir, url.slice(1))), bytes,
        'Restoring the source must reproduce identical content-addressed WebP files.')
    }

    console.log(`Verified ${SOURCE_MANIFEST.length} synthetic JPEGs, ${firstOutputs.size} static WebP variants per baseline, responsive HTML, decoded output pixels, Vite import guard, deterministic builds, and same-slug invalidation (${sourcePixelChanges} source / ${outputPixelChanges} largest-variant pixels changed). Sources were restored byte-for-byte; all generated files are confined to a temporary workspace.`)
  } finally {
    if (sourceToRestore && bytesToRestore) await writeFile(sourceToRestore, bytesToRestore)
    const current = await lstat(scratch)
    assert.ok(current.isDirectory() && !current.isSymbolicLink(), 'Only the script-owned temporary workspace may be removed.')
    assert.equal(await realpath(scratch), canonicalScratch, 'The script-owned temporary workspace changed before cleanup.')
    await rm(scratch, { recursive: true, force: false })
    if (!fixtureAstroDirectoryExisted) {
      try {
        await rmdir(fixtureAstroDirectory)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
}

async function decodedImageFromBytes(bytes) {
  const { data, info } = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height, info.channels], [WIDTH, HEIGHT, CHANNELS])
  return { data, width: info.width, height: info.height }
}

await main()
