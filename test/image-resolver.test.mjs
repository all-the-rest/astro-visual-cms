import assert from 'node:assert/strict'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FIXTURE_IMAGE_SLUGS as DEMO_IMAGE_SLUGS } from '../src/lib/demo-image-manifest.mjs'
import { FIXTURE_IMAGE_SLUGS } from '../src/lib/gallery-patch.mjs'
import { IMAGE_MANIFEST, resolveFixtureImageMetadata, resolveImageMetadata, validateImageManifest } from '../src/lib/image-slug-resolver.mjs'
import { resolveImageSource } from '../src/lib/image-slug-resolver.internal.mjs'
import { createImageManifestImportGuard } from '../src/lib/vite-image-import-guard.mjs'
import { resolveAstroImageMetadata } from '../src/lib/astro-image-adapter.mjs'

const fixtureBytes = await readFile(new URL('../public/images/noise-fixture-01.jpg', import.meta.url))
const fixturePath = new URL('../public/images/noise-fixture-01.jpg', import.meta.url)

function manifestEntry(overrides = {}) {
  return {
    slug: 'test-image',
    file: 'test-image.jpg',
    format: 'jpeg',
    maxBytes: 5 * 1024 * 1024,
    maxPixels: 16_000_000,
    ...overrides,
  }
}

async function withImageRoot(callback) {
  const tempRoot = await realpath(os.tmpdir())
  const imageRoot = await mkdtemp(path.join(tempRoot, 'astro-image-resolver-'))
  try {
    return await callback(imageRoot)
  } finally {
    await rm(imageRoot, { recursive: true, force: true })
  }
}

test('the fixture slug resolver returns path-free metadata with a content hash', async () => {
  assert.deepEqual(IMAGE_MANIFEST.map(({ slug }) => slug), DEMO_IMAGE_SLUGS)
  assert.deepEqual(FIXTURE_IMAGE_SLUGS, DEMO_IMAGE_SLUGS)
  const image = await resolveImageMetadata(FIXTURE_IMAGE_SLUGS[0])
  const fixtureAlias = await resolveFixtureImageMetadata(FIXTURE_IMAGE_SLUGS[0])

  assert.match(image.src, /^\/images\/noise-fixture-01\.jpg\?content=[a-f0-9]{64}$/)
  assert.equal(image.width, 640)
  assert.equal(image.height, 400)
  assert.equal(image.format, 'jpeg')
  assert.deepEqual(Object.keys(image).sort(), ['format', 'height', 'src', 'width'])
  assert.equal(Object.hasOwn(image, 'fsPath'), false)
  assert.equal(JSON.stringify(image).includes(process.cwd()), false)
  assert.deepEqual(fixtureAlias, image)
})

test('unknown slugs fail without echoing caller input', async () => {
  await assert.rejects(() => resolveImageMetadata('../outside'), {
    code: 'UNKNOWN_IMAGE_SLUG',
    message: 'Unknown image slug.',
  })
})

test('the private Astro adapter supplies its experimental fsPath as non-enumerable metadata', async () => {
  const image = await resolveAstroImageMetadata(FIXTURE_IMAGE_SLUGS[0])
  const descriptor = Object.getOwnPropertyDescriptor(image, 'fsPath')

  assert.equal(descriptor?.enumerable, false)
  assert.equal(typeof descriptor?.value, 'string')
  await access(descriptor.value)
  assert.equal(Object.keys(image).includes('fsPath'), false)
  assert.equal(JSON.stringify(image).includes(process.cwd()), false)
})

test('manifest validation rejects duplicate slugs, duplicate files, traversal and format mismatches', () => {
  assert.throws(() => validateImageManifest([]), { code: 'INVALID_IMAGE_MANIFEST' })
  assert.throws(() => validateImageManifest([
    manifestEntry(), manifestEntry({ file: 'second-image.jpg' }),
  ]), { code: 'DUPLICATE_IMAGE_SLUG' })
  assert.throws(() => validateImageManifest([
    manifestEntry(), manifestEntry({ slug: 'second-image' }),
  ]), { code: 'DUPLICATE_IMAGE_FILE' })

  for (const file of ['../outside.jpg', '..\\outside.jpg', '/outside.jpg', 'C:\\outside.jpg']) {
    assert.throws(() => validateImageManifest([manifestEntry({ file })]), { code: 'INVALID_IMAGE_MANIFEST' })
  }
  assert.throws(() => validateImageManifest([manifestEntry({ file: 'test-image.png' })]), {
    code: 'INVALID_IMAGE_MANIFEST',
  })
  assert.throws(() => validateImageManifest([manifestEntry({ maxBytes: 10 * 1024 * 1024 + 1 })]), {
    code: 'INVALID_IMAGE_MANIFEST',
  })
  assert.throws(() => validateImageManifest([manifestEntry({ file: 'test-image.avif', format: 'avif' })]), {
    code: 'INVALID_IMAGE_MANIFEST',
  })
})

test('the Vite guard blocks every manifest image across URL and platform path forms', () => {
  const guard = createImageManifestImportGuard(IMAGE_MANIFEST)
  for (const { file } of IMAGE_MANIFEST) {
    for (const source of [
      `../public/images/${file}?import`,
      `C:\\project\\public\\images\\${file}#asset`,
      `/project/public/images/${encodeURIComponent(file)}?url`,
    ]) {
      assert.throws(() => guard.resolveId(source), /resolved by slug/)
    }
  }
  assert.equal(guard.resolveId('../public/images/unlisted.jpg?import'), undefined)
})

test('the resolver rejects source symlink escapes and non-file sources', async () => {
  await withImageRoot(async (imageRoot) => {
    await symlink(fixturePath, path.join(imageRoot, 'escape.jpg'))
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ file: 'escape.jpg' })],
        imageRoot,
      }),
      { code: 'IMAGE_SOURCE_ESCAPE' },
    )

    await mkdir(path.join(imageRoot, 'directory.jpg'))
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ file: 'directory.jpg' })],
        imageRoot,
      }),
      { code: 'IMAGE_SOURCE_NOT_FILE' },
    )
    assert.equal((await lstat(path.join(imageRoot, 'directory.jpg'))).isDirectory(), true)
  })
})

test('the resolver rejects a symlink used as the trusted image directory', async () => {
  await withImageRoot(async (parentRoot) => {
    const tempRoot = await realpath(os.tmpdir())
    const externalRoot = await mkdtemp(path.join(tempRoot, 'astro-image-outside-'))
    const linkedRoot = path.join(parentRoot, 'linked-images')
    try {
      await copyFile(fixturePath, path.join(externalRoot, 'test-image.jpg'))
      await symlink(externalRoot, linkedRoot, 'dir')

      await assert.rejects(
        () => resolveImageSource('test-image', {
          manifest: [manifestEntry()],
          imageRoot: linkedRoot,
        }),
        { code: 'IMAGE_DIRECTORY_SYMLINK' },
      )
    } finally {
      await rm(externalRoot, { recursive: true, force: true })
    }
  })
})

test('the resolver rejects a symlink in an ancestor of the trusted image directory', async () => {
  await withImageRoot(async (parentRoot) => {
    const tempRoot = await realpath(os.tmpdir())
    const externalProjectRoot = await mkdtemp(path.join(tempRoot, 'astro-image-project-'))
    const linkedProjectRoot = path.join(parentRoot, 'linked-project')
    try {
      const externalImageRoot = path.join(externalProjectRoot, 'public', 'images')
      await mkdir(externalImageRoot, { recursive: true })
      await copyFile(fixturePath, path.join(externalImageRoot, 'test-image.jpg'))
      await symlink(externalProjectRoot, linkedProjectRoot, 'dir')

      await assert.rejects(
        () => resolveImageSource('test-image', {
          manifest: [manifestEntry()],
          imageRoot: path.join(linkedProjectRoot, 'public', 'images'),
        }),
        { code: 'IMAGE_DIRECTORY_SYMLINK' },
      )
    } finally {
      await rm(externalProjectRoot, { recursive: true, force: true })
    }
  })
})

test('the resolver enforces source existence, byte and pixel limits, and actual file format', async () => {
  await withImageRoot(async (imageRoot) => {
    const imagePath = path.join(imageRoot, 'test-image.jpg')
    await copyFile(fixturePath, imagePath)

    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ maxBytes: fixtureBytes.byteLength - 1 })],
        imageRoot,
      }),
      { code: 'IMAGE_SOURCE_TOO_LARGE' },
    )
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ maxPixels: 100 })],
        imageRoot,
      }),
      { code: 'IMAGE_DIMENSIONS_TOO_LARGE' },
    )

    await writeFile(path.join(imageRoot, 'test-image.png'), fixtureBytes)
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ file: 'test-image.png', format: 'png' })],
        imageRoot,
      }),
      { code: 'IMAGE_FORMAT_MISMATCH' },
    )

    await writeFile(path.join(imageRoot, 'invalid.jpg'), Buffer.from('not an image'))
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ file: 'invalid.jpg' })],
        imageRoot,
      }),
      { code: 'INVALID_IMAGE' },
    )
    await assert.rejects(
      () => resolveImageSource('test-image', {
        manifest: [manifestEntry({ file: 'missing.jpg' })],
        imageRoot,
      }),
      { code: 'IMAGE_SOURCE_UNAVAILABLE' },
    )
  })
})
