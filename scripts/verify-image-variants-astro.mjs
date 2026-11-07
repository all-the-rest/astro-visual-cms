import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/image-variants/', import.meta.url))
const ASTRO_CLI = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url))
const WIDTH = 320
const HEIGHT = 180
const CHANNELS = 3
const SOURCE_FILE = 'synthetic-noise.jpg'
const SLUG = 'synthetic-noise'
const VARIANT_WIDTHS = [64, 128, 256]

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deterministicNoise(phase) {
  const seed = createHash('sha256').update(`image-variants-integration:${phase}`).digest()
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

async function createSyntheticJpeg(phase) {
  return sharp(deterministicNoise(phase), {
    raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS },
  }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
}

async function decodeImage(bytes) {
  const { data, info } = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

function changedPixelCount(before, after) {
  assert.deepEqual([before.width, before.height, before.channels], [after.width, after.height, after.channels])
  assert.equal(before.channels, CHANNELS)
  let changed = 0
  for (let index = 0; index < before.data.length; index += CHANNELS) {
    const difference = Math.abs(before.data[index] - after.data[index]) +
      Math.abs(before.data[index + 1] - after.data[index + 1]) +
      Math.abs(before.data[index + 2] - after.data[index + 2])
    if (difference >= 24) changed += 1
  }
  return changed
}

function parseImageUrls(html) {
  const sourceTag = html.match(/<source\b[^>]*>/)?.[0]
  assert.ok(sourceTag, 'The generated page must contain a responsive WebP source.')
  assert.match(sourceTag, /type="image\/webp"/)
  const srcset = sourceTag.match(/srcset="([^"]+)"/)?.[1]
  assert.ok(srcset, 'The generated source must contain a srcset.')
  assert.match(sourceTag, /sizes="100vw"/)
  const urls = srcset.split(', ').map((candidate) => {
    const match = candidate.match(/^(\S+) (\d+)w$/)
    assert.ok(match, `Unexpected srcset candidate: ${candidate}`)
    return { url: match[1], width: Number(match[2]) }
  })
  const imageTag = html.match(/<img\b[^>]*>/)?.[0]
  assert.ok(imageTag, 'The static Astro adapter must render an img fallback.')
  assert.match(imageTag, /alt="Synthetic noise fixture"/)
  assert.match(imageTag, /data-testid="synthetic-image"/)
  assert.equal(urls.at(-1).url, imageTag.match(/src="([^"]+)"/)?.[1])
  assert.doesNotMatch(html, /\.jpe?g(?:[?#" ]|$)/i, 'The page must never expose source JPEG URLs.')
  return urls
}

async function walkFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in generated output: ${filename}`)
    if (entry.isDirectory()) files.push(...await walkFiles(filename))
    else if (entry.isFile()) files.push(filename)
    else throw new Error(`Unexpected non-file in generated output: ${filename}`)
  }
  return files
}

function runBuild(appRoot) {
  const result = spawnSync(process.execPath, [ASTRO_CLI, 'build'], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, IMAGE_VARIANTS_TEST_APP_ROOT: appRoot },
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Synthetic Astro production build exited with ${result.status ?? 'unknown'}.`)
}

function verifySourceImportRejectedByAstroBuild(appRoot) {
  const result = spawnSync(process.execPath, [ASTRO_CLI, 'build'], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, IMAGE_VARIANTS_TEST_APP_ROOT: appRoot },
  })
  if (result.error) throw result.error
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const guardMessage = 'Configured source JPEGs must be transformed at build time, not imported as Vite image modules.'
  assert.notEqual(result.status, 0, 'Astro build must reject a configured source JPEG imported into the Vite graph.')
  assert.ok(output.includes(guardMessage), `Astro/Vite must report the source import guard.\n${output}`)
  console.log('Verified the Astro/Vite production graph rejects a configured source JPEG import.')
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function startDev(appRoot, port) {
  const child = spawn(process.execPath, [ASTRO_CLI, 'dev', '--host', '127.0.0.1', '--port', String(port), '--ignore-lock'], {
    cwd: appRoot,
    env: { ...process.env, IMAGE_VARIANTS_TEST_APP_ROOT: appRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  return { child, exited, get output() { return output } }
}

async function stopDev(dev) {
  if (!dev) return
  if (dev.child.exitCode === null && dev.child.signalCode === null) {
    dev.child.kill('SIGTERM')
    const result = await Promise.race([dev.exited, delay(5_000).then(() => null)])
    if (!result) {
      dev.child.kill('SIGKILL')
      await dev.exited
    }
  } else {
    await dev.exited
  }
}

async function fetchPage(dev, url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (dev.child.exitCode !== null) {
      throw new Error(`Astro dev exited unexpectedly (${dev.child.exitCode}).\n${dev.output}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      const body = await response.text()
      if (response.status === 200) return { response, body }
      if (response.status >= 500) throw new Error(`Astro dev returned ${response.status}: ${body.slice(0, 500)}\n${dev.output}`)
      lastError = new Error(`Astro dev returned ${response.status}.`)
    } catch (error) {
      if (error.message.includes('Astro dev returned 5')) throw error
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for Astro dev at ${url}: ${lastError?.message ?? 'no response'}\n${dev.output}`)
}

async function waitForHtml(dev, url, predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastHtml = ''
  while (Date.now() < deadline) {
    if (dev.child.exitCode !== null) throw new Error(`Astro dev exited while waiting for ${description}.\n${dev.output}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      lastHtml = await response.text()
      if (response.status === 200 && predicate(lastHtml)) return lastHtml
      if (response.status >= 500) {
        throw new Error(`Astro dev returned ${response.status} while waiting for ${description}: ${lastHtml.slice(0, 500)}\n${dev.output}`)
      }
    } catch (error) {
      if (error.message.includes('Astro dev returned 5')) throw error
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${description}. Last HTML: ${lastHtml.slice(0, 800)}\n${dev.output}`)
}

async function fetchWebp(baseUrl, variant, dev) {
  const deadline = Date.now() + 5_000
  let response
  let body
  while (Date.now() < deadline) {
    response = await fetch(new URL(variant.url, baseUrl), { signal: AbortSignal.timeout(1_500) })
    if (response.status === 200) break
    body = await response.text()
    if (response.status !== 404) break
    await delay(50)
  }
  assert.equal(response?.status, 200,
    `Generated static URL must be served: ${variant.url}; response=${body}\n${dev?.output ?? ''}`)
  assert.match(response.headers.get('content-type') ?? '', /image\/webp/i)
  const bytes = Buffer.from(await response.arrayBuffer())
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, variant.width)
  assert.equal(metadata.height, Math.round(HEIGHT * variant.width / WIDTH))
  return { bytes, pixels: await decodeImage(bytes) }
}

async function readBuiltWebp(distRoot, variant) {
  assert.ok(variant.url.startsWith('/variants/'))
  const bytes = await readFile(path.join(distRoot, variant.url.slice(1)))
  const metadata = await sharp(bytes).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, variant.width)
  assert.equal(metadata.height, Math.round(HEIGHT * variant.width / WIDTH))
  return { bytes, pixels: await decodeImage(bytes) }
}

async function waitForLog(dev, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (dev.output.includes(expected)) return
    if (dev.child.exitCode !== null) throw new Error(`Astro dev exited before logging ${expected}.\n${dev.output}`)
    await delay(50)
  }
  throw new Error(`Timed out waiting for Astro dev log ${expected}.\n${dev.output}`)
}

async function createSyntheticApp(scratch) {
  const appRoot = path.join(scratch, 'app')
  const sourceRoot = path.join(scratch, 'inputs')
  const publicRoot = path.join(appRoot, 'public')
  await Promise.all([
    mkdir(path.join(appRoot, 'src', 'pages'), { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(publicRoot, { recursive: true }),
  ])
  await writeFile(path.join(appRoot, 'src', 'pages', 'index.astro'), await readFile(path.join(FIXTURE_ROOT, 'src', 'pages', 'index.astro')))
  await writeFile(path.join(appRoot, 'astro.config.mjs'), await readFile(path.join(FIXTURE_ROOT, 'astro.config.mjs')))
  await symlink(path.join(REPOSITORY_ROOT, 'node_modules'), path.join(appRoot, 'node_modules'), 'dir')

  const config = {
    manifest: {
      version: 1,
      images: [{
        slug: SLUG,
        file: SOURCE_FILE,
        format: 'jpeg',
        maxBytes: 1_000_000,
        maxPixels: WIDTH * HEIGHT,
        widths: VARIANT_WIDTHS,
      }],
    },
    sourceRoot: path.relative(appRoot, sourceRoot),
    outputDir: 'public/variants',
    publicPath: '/variants',
  }
  await writeFile(path.join(appRoot, 'image-variants.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  return { appRoot, sourceRoot, publicRoot, sourcePath: path.join(sourceRoot, SOURCE_FILE) }
}

async function verifyProductionOutput(appRoot, initialUrls) {
  const distRoot = path.join(appRoot, 'dist')
  const astroTypesRoot = path.join(appRoot, '.astro')
  const typeIndex = await readFile(path.join(astroTypesRoot, 'types.d.ts'), 'utf8')
  const injectedTypesPath = path.join(
    astroTypesRoot,
    'integrations',
    'astro-visual-cms-image-variants',
    'image-variants.d.ts',
  )
  assert.match(typeIndex, /integrations\/astro-visual-cms-image-variants\/image-variants\.d\.ts/)
  const injectedTypes = await readFile(injectedTypesPath, 'utf8')
  assert.match(injectedTypes, /declare module 'virtual:astro-visual-cms\/image-variants'/)
  assert.match(injectedTypes, /getImageVariants\(slug: string\)/)
  const html = await readFile(path.join(distRoot, 'index.html'), 'utf8')
  const builtUrls = parseImageUrls(html)
  assert.deepEqual(builtUrls, initialUrls)
  const files = await walkFiles(distRoot)
  assert.ok(files.length > 0)
  assert.equal(files.filter((filename) => filename.endsWith('.webp')).length, VARIANT_WIDTHS.length)
  assert.ok(files.every((filename) => !/\.jpe?g$/i.test(filename)), 'Production output must not copy source JPEGs.')
  for (const filename of files.filter((item) => /\.(?:html|js|css|json)$/i.test(item))) {
    const content = await readFile(filename, 'utf8')
    assert.doesNotMatch(content, new RegExp(SOURCE_FILE.replace('.', '\\.'), 'i'), 'No source JPEG name may enter generated HTML or JS.')
  }
  for (const variant of builtUrls) {
    const outputPath = path.join(distRoot, variant.url.slice(1))
    const stat = await lstat(outputPath)
    assert.ok(stat.isFile() && !stat.isSymbolicLink())
    const metadata = await sharp(outputPath).metadata()
    assert.deepEqual([metadata.format, metadata.width], ['webp', variant.width])
  }
}

async function main() {
  const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), 'image-variants-astro-proof-'))
  const canonicalScratch = await realpath(scratch)
  assert.equal(canonicalScratch, scratch, 'The script-owned temporary root must not be a symlink.')
  let dev
  let sourcePath
  let originalBytes

  try {
    const app = await createSyntheticApp(scratch)
    sourcePath = app.sourcePath
    originalBytes = await createSyntheticJpeg('initial')
    await writeFile(sourcePath, originalBytes, { flag: 'wx' })

    const forbiddenPage = path.join(app.appRoot, 'src', 'pages', 'forbidden.astro')
    const sourceImportPath = path.relative(path.dirname(forbiddenPage), sourcePath).split(path.sep).join('/')
    await writeFile(forbiddenPage, `---\nimport source from '${sourceImportPath}'\n---\n<img src={source} alt="must be blocked" />\n`, { flag: 'wx' })
    verifySourceImportRejectedByAstroBuild(app.appRoot)
    await rm(forbiddenPage)

    console.log('\n--- Synthetic Astro production build via @astro-visual-cms/image-variants/astro ---')
    runBuild(app.appRoot)
    const productionHtml = await readFile(path.join(app.appRoot, 'dist', 'index.html'), 'utf8')
    const initialUrls = parseImageUrls(productionHtml)
    assert.deepEqual(initialUrls.map(({ width }) => width), VARIANT_WIDTHS)
    await verifyProductionOutput(app.appRoot, initialUrls)
    const initialVariants = await Promise.all(initialUrls.map((variant) => readBuiltWebp(path.join(app.appRoot, 'dist'), variant)))

    const port = await availablePort()
    const baseUrl = `http://127.0.0.1:${port}/`
    dev = startDev(app.appRoot, port)
    const initialPage = await fetchPage(dev, baseUrl)
    assert.deepEqual(parseImageUrls(initialPage.body), initialUrls, 'Dev startup must expose the generated static variants.')
    for (const variant of initialUrls) {
      const publicAsset = path.join(app.publicRoot, variant.url.slice(1))
      const stat = await lstat(publicAsset)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Dev static asset should exist before HTTP fetch: ${publicAsset}`)
    }
    const sourceResponse = await fetch(new URL(`sources/${SOURCE_FILE}`, baseUrl), { signal: AbortSignal.timeout(5_000) })
    assert.notEqual(sourceResponse.status, 200, 'Source JPEGs must not be publicly served by the Astro dev server.')
    assert.notDeepEqual(Buffer.from(await sourceResponse.arrayBuffer()), originalBytes)

    const alternateBytes = await createSyntheticJpeg('alternate')
    await writeFile(sourcePath, alternateBytes)
    const alternateHtml = await waitForHtml(
      dev,
      baseUrl,
      (html) => {
        try { return parseImageUrls(html).some(({ url }) => !initialUrls.some((entry) => entry.url === url)) } catch { return false }
      },
      'watch invalidation to publish a new source-hash URL',
    )
    const alternateUrls = parseImageUrls(alternateHtml)
    assert.deepEqual(alternateUrls.map(({ width }) => width), VARIANT_WIDTHS)
    assert.ok(alternateUrls.every((variant, index) => variant.url !== initialUrls[index].url), 'A changed source must receive new URLs at every width.')
    const alternateVariants = await Promise.all(alternateUrls.map((variant) => fetchWebp(baseUrl, variant, dev)))
    let changedLargestPixels = 0
    for (let index = 0; index < alternateVariants.length; index += 1) {
      const changed = changedPixelCount(initialVariants[index].pixels, alternateVariants[index].pixels)
      assert.ok(changed > VARIANT_WIDTHS[index] * Math.round(HEIGHT * VARIANT_WIDTHS[index] / WIDTH) * 0.5,
        'Watch invalidation must serve visibly changed decoded WebP pixels.')
      if (VARIANT_WIDTHS[index] === VARIANT_WIDTHS.at(-1)) changedLargestPixels = changed
    }
    const previousStillServed = await fetchWebp(baseUrl, initialUrls[0], dev)
    assert.deepEqual(previousStillServed.bytes, initialVariants[0].bytes, 'Content-addressed old variants must remain available after regeneration.')

    const invalidBytes = Buffer.from('not a JPEG; the previous successful result must remain usable')
    await writeFile(sourcePath, invalidBytes)
    await waitForLog(dev, 'Image-variants regeneration failed; preserving the last successful manifest and files:')
    const preservedHtml = await fetchPage(dev, baseUrl)
    assert.deepEqual(parseImageUrls(preservedHtml.body), alternateUrls, 'Failed generation must preserve the last successful URLs.')
    const preservedVariant = await fetchWebp(baseUrl, alternateUrls.at(-1), dev)
    assert.deepEqual(preservedVariant.bytes, alternateVariants.at(-1).bytes, 'Failed generation must preserve the last successful output bytes.')

    const recoveryBytes = await createSyntheticJpeg('recovered')
    await writeFile(sourcePath, recoveryBytes)
    const recoveredHtml = await waitForHtml(
      dev,
      baseUrl,
      (html) => {
        try { return parseImageUrls(html).some(({ url }) => !alternateUrls.some((entry) => entry.url === url)) } catch { return false }
      },
      'watch recovery after a failed source transform',
    )
    const recoveredUrls = parseImageUrls(recoveredHtml)
    assert.ok(recoveredUrls.every((variant, index) => variant.url !== alternateUrls[index].url))
    const recoveredVariants = await Promise.all(recoveredUrls.map((variant) => fetchWebp(baseUrl, variant, dev)))
    assert.ok(changedPixelCount(alternateVariants.at(-1).pixels, recoveredVariants.at(-1).pixels) >
      VARIANT_WIDTHS.at(-1) * Math.round(HEIGHT * VARIANT_WIDTHS.at(-1) / WIDTH) * 0.5)

    console.log(`Verified production build, ${initialUrls.length} static WebP assets, dev HTTP serving, source-import graph guard, same-slug watch invalidation (${changedLargestPixels} largest-variant pixels changed), failure preservation, recovery, and clean dev shutdown.`)
  } finally {
    await stopDev(dev)
    if (sourcePath && originalBytes) await writeFile(sourcePath, originalBytes)
    const current = await lstat(scratch)
    assert.ok(current.isDirectory() && !current.isSymbolicLink(), 'Only the script-owned synthetic workspace may be removed.')
    assert.equal(await realpath(scratch), canonicalScratch, 'The owned temporary root changed before cleanup.')
    await rm(scratch, { recursive: true, force: false })
  }
}

await main()
