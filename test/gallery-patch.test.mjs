import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compile } from '@mdx-js/mdx'
import {
  createGalleryPatchAdapter,
  FIXTURE_IMAGE_SLUGS,
  hashSource,
  inspectFixture,
  patchFixtureSource,
} from '../src/lib/gallery-patch.mjs'

const FIXTURE_PATH = new URL('../src/pages/fixture.mdx', import.meta.url)

function sourceWith(arrays, galleries, { importLine = "import Gallery from '../components/Gallery.astro';", before = '' } = {}) {
  return `${importLine}\n\n${before}${before ? '\n\n' : ''}${arrays}\n\n${galleries}\n`
}

const simpleArrays = `export const FIRST = ["story-cover", "market-detail"];
export const SECOND = ["evening-window"];`
const simpleGalleries = `<Gallery sorted={FIRST} />
<Gallery sorted={SECOND} />`

test('the fixed synthetic fixture is valid MDX with realistic text, an unknown component, and multiple galleries', async () => {
  const source = await readFile(FIXTURE_PATH, 'utf8')
  const compiled = await compile(source, { format: 'mdx' })
  assert.match(String(compiled), /function _createMdxContent/)
  assert.match(source, /import Gallery/)
  assert.match(source, /import EditorUnknownChip/)
  assert.match(source, /<Gallery sorted=\{HIGHLIGHTS\}/)
  assert.match(source, /<Gallery sorted=\{DETAILS\}/)
  assert.doesNotMatch(source, /<Gallery\s+id=/)
  assert.match(source, /fully synthetic|vollständig synthetisch/i)
  assert.match(source, /<EditorUnknownChip/)
  const state = inspectFixture(source)
  assert.deepEqual(state.galleries, [
    { id: 'HIGHLIGHTS', order: [FIXTURE_IMAGE_SLUGS[0], FIXTURE_IMAGE_SLUGS[2]] },
    { id: 'DETAILS', order: [FIXTURE_IMAGE_SLUGS[1]] },
  ])
})

test('patching one gallery preserves every source character outside its AST array range', () => {
  const source = sourceWith(
    `export const FIRST = ["story-cover", "market-detail"];
export const SECOND = ["evening-window"];`,
    simpleGalleries,
    { before: '\n# 🧭 Küstenroute\n\nEin synthetischer Text mit Emoji vor den Exporten.\n' },
  ).replaceAll('\n', '\r\n')
  const current = inspectFixture(source)
  const order = [...current.galleries[0].order].reverse()
  const patched = patchFixtureSource(source, 'FIRST', order, current.hash)
  const originalArray = '["story-cover", "market-detail"]'
  const originalArrayStart = source.indexOf(originalArray)
  const expected = source.slice(0, originalArrayStart) + JSON.stringify(order) +
    source.slice(originalArrayStart + originalArray.length)

  assert.deepEqual(Buffer.from(patched.source, 'utf8'), Buffer.from(expected, 'utf8'))
  assert.deepEqual(patched.galleries, [
    { id: 'FIRST', order },
    { id: 'SECOND', order: ['evening-window'] },
  ])
  assert.equal(patched.hash, hashSource(expected))
})

test('stale hashes and requests that add, drop, duplicate, path-inject, or target an unknown gallery fail closed', () => {
  const source = sourceWith(simpleArrays, simpleGalleries)
  const current = inspectFixture(source)
  const order = current.galleries[0].order
  assert.throws(() => patchFixtureSource(source, 'FIRST', order, '0'.repeat(64)), { code: 'STALE_HASH' })
  for (const malformedHash of ['', 'not-a-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null]) {
    assert.throws(() => patchFixtureSource(source, 'FIRST', order, malformedHash), { code: 'STALE_HASH' })
  }
  assert.throws(() => patchFixtureSource(source, 'FIRST', [...order, 'noise-fixture-03'], current.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => patchFixtureSource(source, 'FIRST', [order[0], order[0]], current.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => patchFixtureSource(source, 'FIRST', ['/elsewhere.jpg', order[1]], current.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => patchFixtureSource(source, '../other.mdx', order, current.hash), { code: 'UNSUPPORTED_TARGET' })
})

test('two writes based on one revision conflict without overwriting the accepted write', () => {
  const adapter = createGalleryPatchAdapter()
  const source = sourceWith(simpleArrays, simpleGalleries)
  const revision = adapter.inspect(source)
  const firstOrder = [...revision.galleries[0].order].reverse()
  const accepted = adapter.patch(source, 'FIRST', firstOrder, revision.hash)
  const acceptedBytes = Buffer.from(accepted.source, 'utf8')

  assert.throws(
    () => adapter.patch(accepted.source, 'SECOND', ['evening-window'], revision.hash),
    { code: 'STALE_HASH' },
  )
  assert.deepEqual(Buffer.from(accepted.source, 'utf8'), acceptedBytes)
  assert.deepEqual(adapter.inspect(accepted.source).galleries, [
    { id: 'FIRST', order: firstOrder },
    { id: 'SECOND', order: ['evening-window'] },
  ])
})

test('original Gallery form accepts arbitrary string slugs; dynamic values and non-unique targets fail closed', () => {
  const valid = sourceWith(simpleArrays, simpleGalleries)
  assert.deepEqual(inspectFixture(valid).galleries.map(({ order }) => order), [
    ['story-cover', 'market-detail'],
    ['evening-window'],
  ])
  assert.deepEqual(inspectFixture(sourceWith(
    'export const SORTING = ["customer-photo-a", "another.valid_slug"];',
    '<Gallery sorted={SORTING} />',
  )).galleries, [{ id: 'SORTING', order: ['customer-photo-a', 'another.valid_slug'] }])

  const invalid = [
    valid.replace('FIRST = [', 'FIRST = [...OTHER, '),
    valid.replace('FIRST = [', 'FIRST = [getImage(), '),
    valid.replace('<Gallery sorted={FIRST}', '<Gallery {...props} sorted={FIRST}'),
    valid.replace('sorted={FIRST}', 'sorted={getImages()}'),
    valid.replace('sorted={FIRST}', 'sorted={SECOND}'),
    valid.replace('export const FIRST', 'export let FIRST'),
    valid.replace('FIRST = [', 'FIRST = ["", '),
    valid.replace('FIRST = [', 'FIRST = ["story-cover", '),
  ]
  for (const source of invalid) assert.throws(() => inspectFixture(source))

  assert.deepEqual(inspectFixture(sourceWith(
    'export const PICKS = ["customer-photo-a"];',
    '<Gallery id="PICKS" sorted={PICKS} />',
  )).galleries, [{ id: 'PICKS', order: ['customer-photo-a'] }])
  assert.throws(() => inspectFixture(sourceWith(
    'export const PICKS = ["customer-photo-a"];',
    '<Gallery id="NOT_PICKS" sorted={PICKS} />',
  )), { code: 'UNSUPPORTED_TARGET' })
})

test('unknown JSX is ignored while Gallery import identity and unique array use are enforced', () => {
  const alias = sourceWith(
    'export const PICKS = ["noise-fixture-02"];',
    '<EditorUnknownChip label="unchanged" />\n<PhotoGallery sorted={PICKS} />',
    { importLine: "import PhotoGallery from '../components/Gallery.astro';\nimport EditorUnknownChip from './EditorUnknownChip.astro';" },
  )
  assert.deepEqual(inspectFixture(alias).galleries, [{ id: 'PICKS', order: ['noise-fixture-02'] }])

  const wrongImport = sourceWith('export const PICKS = ["noise-fixture-02"];', '<Gallery sorted={PICKS} />', {
    importLine: "import Gallery from './NotTheGallery.astro';",
  })
  assert.throws(() => inspectFixture(wrongImport), { code: 'UNSUPPORTED_TARGET' })

  const duplicateGallery = sourceWith('export const PICKS = ["noise-fixture-02"];',
    '<Gallery sorted={PICKS} />\n<Gallery sorted={PICKS} />')
  assert.throws(() => inspectFixture(duplicateGallery), { code: 'UNSUPPORTED_TARGET' })

  const extraUse = sourceWith('export const PICKS = ["noise-fixture-02"];',
    '<Gallery sorted={PICKS} />\n\nThe raw value is also used here: {PICKS[0]}.')
  assert.throws(() => inspectFixture(extraUse), { code: 'UNSUPPORTED_TARGET' })
})

test('array references inside JSX spread attributes count as extra uses', () => {
  const source = sourceWith(
    'export const PICKS = ["noise-fixture-02"];',
    '<Gallery sorted={PICKS} />\n<EditorUnknownChip {...{ value: PICKS }} />',
  )
  assert.throws(() => inspectFixture(source), { code: 'UNSUPPORTED_TARGET' })
})

test('array references inside nested JSX expressions count as extra uses', () => {
  const source = sourceWith(
    'export const PICKS = ["first", "second"];',
    '<Gallery sorted={PICKS} />\n<Unknown value={<span>{PICKS}</span>} />',
  )
  assert.throws(() => inspectFixture(source), { code: 'UNSUPPORTED_TARGET' })
})

test('exported arrays used as MDX component names count as extra uses', () => {
  for (const componentUse of ['<PICKS />', '<PICKS.Card />']) {
    const source = sourceWith(
      'export const PICKS = ["first"];',
      `<Gallery sorted={PICKS} />\n${componentUse}`,
    )
    assert.throws(() => inspectFixture(source), { code: 'UNSUPPORTED_TARGET' })
  }
})

test('direct eval in ESM or MDX expressions fails closed during array-use detection', () => {
  const esmEval = sourceWith(
    'export const PICKS = ["noise-fixture-02"];\nexport const DYNAMIC = eval(\'PICKS\');',
    '<Gallery sorted={PICKS} />',
  )
  const mdxEval = sourceWith(
    'export const PICKS = ["noise-fixture-02"];',
    '<Gallery sorted={PICKS} />\n\n{eval(\'PICKS\')}',
  )
  assert.throws(() => inspectFixture(esmEval), { code: 'UNSUPPORTED_DYNAMIC_VALUE' })
  assert.throws(() => inspectFixture(mdxEval), { code: 'UNSUPPORTED_DYNAMIC_VALUE' })
})

test('a trusted import identity option supports article-relative paths without confusing same-named imports', () => {
  const importSource = '../../content/components/Gallery.astro'
  const adapter = createGalleryPatchAdapter({ galleryImportSource: importSource })
  const source = sourceWith(
    'export const SORTING = ["article-cover", "article-detail"];',
    '<ArticleGallery id="SORTING" sorted={SORTING} />',
    { importLine: `import ArticleGallery from '${importSource}';` },
  )

  const current = adapter.inspect(source)
  assert.deepEqual(current.galleries, [{ id: 'SORTING', order: ['article-cover', 'article-detail'] }])
  const patched = adapter.patch(source, 'SORTING', [...current.galleries[0].order].reverse(), current.hash)
  assert.deepEqual(adapter.inspect(patched.source).galleries, [
    { id: 'SORTING', order: ['article-detail', 'article-cover'] },
  ])
  assert.throws(() => inspectFixture(source), { code: 'UNSUPPORTED_TARGET' })

  const conflictingImports = sourceWith(
    'export const ARTICLE_SORTING = ["article-cover"];\nexport const FIXTURE_SORTING = ["fixture-cover"];',
    '<Gallery sorted={FIXTURE_SORTING} />\n<ArticleGallery sorted={ARTICLE_SORTING} />',
    { importLine: `import Gallery from '../components/Gallery.astro';\nimport ArticleGallery from '${importSource}';` },
  )
  assert.deepEqual(adapter.inspect(conflictingImports).galleries, [
    { id: 'ARTICLE_SORTING', order: ['article-cover'] },
  ])
  assert.deepEqual(inspectFixture(conflictingImports).galleries, [
    { id: 'FIXTURE_SORTING', order: ['fixture-cover'] },
  ])
})

test('dynamic or ambiguous MDX cannot be patched and leaves its source bytes untouched', () => {
  const adapter = createGalleryPatchAdapter()
  const dynamic = sourceWith(
    'export const PICKS = [getImage()];',
    '<Gallery sorted={PICKS} />',
  )
  const ambiguous = sourceWith(
    'export const PICKS = ["first"];',
    '<Gallery sorted={PICKS} />\n<Gallery sorted={PICKS} />',
  )

  for (const source of [dynamic, ambiguous]) {
    const before = Buffer.from(source, 'utf8')
    assert.throws(() => adapter.patch(source, 'PICKS', ['first'], hashSource(source)))
    assert.deepEqual(Buffer.from(source, 'utf8'), before)
  }
})

test('gallery import identity options reject filesystem/client paths and unrelated options', () => {
  const source = sourceWith('export const SORTING = ["article-cover"];', '<Gallery sorted={SORTING} />', {
    importLine: "import Gallery from '../../content/components/Gallery.astro';",
  })
  for (const options of [
    { galleryImportSource: '/private/Gallery.astro' },
    { galleryImportSource: 'file:///private/Gallery.astro' },
    { galleryImportSource: '../../content/components/Gallery.astro', filePath: '/private/page.mdx' },
  ]) {
    assert.throws(() => inspectFixture(source, options), { code: 'INVALID_IMPORT_IDENTITY' })
  }
})

test('ambiguous exports and comments fail closed', () => {
  const source = sourceWith('export const FIRST = ["story-cover"];', '<Gallery sorted={FIRST} />')
  assert.throws(() => inspectFixture(source.replace('FIRST = [', 'FIRST = [\n  /* keep order */ ')))
  assert.throws(() => inspectFixture(source.replace('export const FIRST', 'const FIRST').replace('<Gallery', 'export { FIRST };\n<Gallery')))
  assert.throws(() => inspectFixture(source.replace('import Gallery', '/* comment */\nimport Gallery')))
})
