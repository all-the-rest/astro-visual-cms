import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import sharp from 'sharp'
import { imageVariants, IMAGE_VARIANTS_VIRTUAL_ID } from '../src/astro.mjs'

const manifest = {
  version: 1,
  images: [{
    slug: 'synthetic-cover',
    file: 'synthetic-cover.jpg',
    format: 'jpeg',
    maxBytes: 100_000,
    maxPixels: 100_000,
    widths: [8, 16],
  }],
}

async function withWorkspace(callback) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'image-variants-astro-api-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Astro config hook generates before Vite setup, exposes URL metadata, and guards exact source paths', async () => {
  await withWorkspace(async (root) => {
    const sourceRoot = path.join(root, 'source')
    const publicDir = path.join(root, 'public')
    const outputDir = path.join(publicDir, 'variants')
    await mkdir(sourceRoot)
    await mkdir(publicDir)
    const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#814326' } })
      .jpeg({ quality: 85 })
      .toBuffer()
    await writeFile(path.join(sourceRoot, manifest.images[0].file), bytes)
    const otherRoot = path.join(root, 'other')
    await mkdir(otherRoot)
    await writeFile(path.join(otherRoot, manifest.images[0].file), bytes)

    const integration = imageVariants({ manifest, sourceRoot, outputDir, publicPath: '/variants' })
    let viteConfig
    await integration.hooks['astro:config:setup']({
      config: {
        root: pathToFileURL(`${root}${path.sep}`),
        publicDir: pathToFileURL(`${publicDir}${path.sep}`),
        output: 'static',
      },
      updateConfig(value) { viteConfig = value },
    })

    assert.ok(viteConfig)
    assert.equal(viteConfig.vite.plugins.length, 2)
    const [virtualPlugin, importGuard] = viteConfig.vite.plugins
    const resolvedId = virtualPlugin.resolveId(IMAGE_VARIANTS_VIRTUAL_ID)
    const moduleSource = virtualPlugin.load(resolvedId)
    assert.match(moduleSource, /export function getImageVariants/)
    assert.doesNotMatch(moduleSource, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const virtual = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)
    const image = virtual.getImageVariants('synthetic-cover')
    assert.equal(image.variants.length, 2)
    assert.equal(Object.hasOwn(image, 'fsPath'), false)
    assert.throws(() => virtual.getImageVariants('missing'), /Unknown image-variants slug/)
    await assert.rejects(
      () => importGuard.resolveId('./synthetic-cover.jpg?import', path.join(sourceRoot, 'consumer.mjs')),
      /not imported as Vite image modules/,
    )
    await assert.rejects(
      () => importGuard.resolveId('./synthetic-cover%2Ejpg?import', path.join(sourceRoot, 'consumer.mjs')),
      /not imported as Vite image modules/,
    )
    await assert.rejects(
      () => importGuard.resolveId(`${pathToFileURL(path.join(sourceRoot, 'synthetic-cover.jpg')).href}?import#image`, undefined),
      /not imported as Vite image modules/,
    )
    assert.equal(await importGuard.resolveId('./synthetic-cover.jpg?import', path.join(otherRoot, 'consumer.mjs')), undefined)
    await assert.rejects(
      () => importGuard.resolveId('./synthetic-cover.jpg?import'),
      /Could not safely resolve/,
    )
    await assert.rejects(
      () => importGuard.resolveId('./synthetic-cover.jpg%ZZ?import'),
      /Could not safely resolve/,
    )
  })
})

test('Astro integration rejects server output and output paths outside publicDir', async () => {
  await withWorkspace(async (root) => {
    const sourceRoot = path.join(root, 'source')
    const publicDir = path.join(root, 'public')
    await mkdir(sourceRoot)
    await mkdir(publicDir)
    const options = { manifest, sourceRoot, outputDir: path.join(root, 'outside'), publicPath: '/variants' }
    const integration = imageVariants(options)
    const args = {
      config: { root: pathToFileURL(`${root}${path.sep}`), publicDir: pathToFileURL(`${publicDir}${path.sep}`), output: 'static' },
      updateConfig() {},
    }
    await assert.rejects(() => integration.hooks['astro:config:setup'](args), /within publicDir/)

    const serverOutput = imageVariants({ ...options, outputDir: path.join(publicDir, 'variants') })
    await assert.rejects(() => serverOutput.hooks['astro:config:setup']({
      ...args,
      config: { ...args.config, output: 'server' },
    }), /requires Astro output/)
  })
})

test('Astro integration injects declarations for its virtual manifest module', async () => {
  let injected
  const integration = imageVariants({
    manifest,
    sourceRoot: '/synthetic/source',
    outputDir: '/synthetic/public/variants',
    publicPath: '/variants',
  })
  await integration.hooks['astro:config:done']({
    injectTypes(value) { injected = value },
  })

  assert.equal(injected.filename, 'image-variants.d.ts')
  assert.match(injected.content, /declare module 'virtual:astro-visual-cms\/image-variants'/)
  assert.match(injected.content, /export function getImageVariants\(slug: string\)/)
  assert.match(injected.content, /export const imageVariants:/)
  assert.match(injected.content, /export default manifest/)
})
