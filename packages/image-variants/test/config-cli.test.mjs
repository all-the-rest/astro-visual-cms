import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  loadImageVariantsConfig,
  resolveImageVariantsConfig,
  validateImageVariantsManifest,
} from '../src/config.mjs'
import { runCli } from '../src/cli.mjs'

const manifest = {
  version: 1,
  images: [{
    slug: 'noise-cover',
    file: 'noise-cover.jpg',
    format: 'jpeg',
    maxBytes: 100_000,
    maxPixels: 100_000,
    widths: [8, 16],
  }],
}

async function withWorkspace(callback) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'image-variants-config-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('config validation is shared, strict, and resolves relative paths from its supplied base', async () => {
  assert.throws(() => validateImageVariantsManifest({ ...manifest, version: 2 }), { code: 'INVALID_IMAGE_MANIFEST' })
  assert.throws(() => validateImageVariantsManifest({ ...manifest, images: [{ ...manifest.images[0], alt: 'not technical metadata' }] }), {
    code: 'INVALID_IMAGE_MANIFEST',
  })
  assert.throws(() => resolveImageVariantsConfig({
    manifest,
    sourceRoot: './input',
    outputDir: './out',
    publicPath: '/variants/../escape',
  }, { baseDir: path.resolve('.') }), { code: 'INVALID_IMAGE_CONFIG' })
  assert.throws(() => resolveImageVariantsConfig({
    manifest,
    sourceRoot: './input',
    outputDir: './out',
    publicPath: '/public variants',
  }, { baseDir: path.resolve('.') }), { code: 'INVALID_IMAGE_CONFIG' })

  const baseDir = path.resolve('fixtures')
  const resolved = resolveImageVariantsConfig({ manifest, sourceRoot: './input', outputDir: './public/variants' }, { baseDir })
  assert.equal(resolved.sourceRoot, path.join(baseDir, 'input'))
  assert.equal(resolved.outputDir, path.join(baseDir, 'public/variants'))
  assert.equal(resolved.publicPath, '/variants')
})

test('CLI loads the same JSON config contract and emits the generated technical manifest', async () => {
  await withWorkspace(async (root) => {
    const sourceRoot = path.join(root, 'input')
    await mkdir(sourceRoot)
    const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#315273' } })
      .jpeg({ quality: 85 })
      .toBuffer()
    await writeFile(path.join(sourceRoot, manifest.images[0].file), bytes)
    const configFile = path.join(root, 'image-variants.json')
    await writeFile(configFile, JSON.stringify({
      manifest,
      sourceRoot: './input',
      outputDir: './public/variants',
      publicPath: '/variants',
    }))

    const loaded = await loadImageVariantsConfig(configFile)
    assert.equal(loaded.sourceRoot, sourceRoot)
    let stdout = ''
    let stderr = ''
    const code = await runCli(['generate', '--config', configFile], {
      cwd: root,
      stdout: { write(value) { stdout += value } },
      stderr: { write(value) { stderr += value } },
    })
    assert.equal(code, 0, stderr)
    const result = JSON.parse(stdout)
    assert.equal(result.version, 1)
    assert.equal(result.images[0].slug, 'noise-cover')
    assert.equal(result.images[0].variants.length, 2)
    assert.equal(stderr, '')
  })
})
