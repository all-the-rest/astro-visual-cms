import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compile } from '@mdx-js/mdx'
import { FIXTURE_IMAGE_SLUGS, hashSource, inspectFixture, patchFixtureSource } from '../src/lib/gallery-patch.mjs'

const FIXTURE_PATH = new URL('../src/pages/fixture.mdx', import.meta.url)

test('the fixture is valid MDX with Markdown, imports, an editor-unknown component, and a sorted Gallery', async () => {
  const source = await readFile(FIXTURE_PATH, 'utf8')
  const compiled = await compile(source, { format: 'mdx' })
  assert.match(String(compiled), /function _createMdxContent/)
  assert.match(source, /import Gallery/)
  assert.match(source, /import EditorUnknownChip/)
  assert.match(source, /<Gallery sorted=\{SORTING\}/)
  assert.deepEqual(inspectFixture(source).order, FIXTURE_IMAGE_SLUGS)
})

test('patch preserves every source byte outside the literal SORTING array', async () => {
  const source = await readFile(FIXTURE_PATH, 'utf8')
  const current = inspectFixture(source)
  const order = [...current.order].reverse()
  const patched = patchFixtureSource(source, order, current.hash)
  const originalArrayStart = source.indexOf('[', source.indexOf('SORTING ='))
  const originalArrayEnd = source.indexOf('];', originalArrayStart) + 1
  const patchedArrayStart = patched.source.indexOf('[', patched.source.indexOf('SORTING ='))
  const patchedArrayEnd = patched.source.indexOf('];', patchedArrayStart) + 1
  assert.equal(patched.source.slice(0, patchedArrayStart), source.slice(0, originalArrayStart))
  assert.equal(patched.source.slice(patchedArrayEnd), source.slice(originalArrayEnd))
  assert.deepEqual(inspectFixture(patched.source).order, order)
  assert.equal(patched.hash, hashSource(patched.source))
})

test('stale source hashes conflict and requested values cannot add, drop, or duplicate entries', async () => {
  const source = await readFile(FIXTURE_PATH, 'utf8')
  const current = inspectFixture(source)
  assert.throws(() => patchFixtureSource(source, current.order, '0'.repeat(64)), { code: 'STALE_HASH' })
  assert.throws(() => patchFixtureSource(source, [...current.order, '/elsewhere.jpg'], current.hash), { code: 'UNSUPPORTED_VALUE' })
  assert.throws(() => patchFixtureSource(source, [current.order[0], current.order[0], current.order[2]], current.hash), { code: 'UNSUPPORTED_VALUE' })
})

test('comments, spreads, dynamic arrays, and non-literal Gallery props fail closed', () => {
  const base = `import Gallery from './Gallery.astro';\nexport const SORTING = [${FIXTURE_IMAGE_SLUGS.map((slug) => JSON.stringify(slug)).join(', ')}];\n<Gallery sorted={SORTING} />\n`
  const commentSource = base.replace('SORTING = [', 'SORTING = [\n  /* keep order */ ')
  assert.throws(() => inspectFixture(commentSource))
  assert.throws(() => inspectFixture(base.replace('<Gallery', '{/* comment */}\n<Gallery')))
  const unsupported = [
    base.replace('SORTING = [', 'SORTING = [...OTHER, '),
    base.replace('SORTING = [', 'SORTING = [getImages(), '),
    base.replace('sorted={SORTING}', 'sorted={getSorting()}'),
    base.replace('<Gallery', '<Gallery {...props}'),
  ]
  for (const source of unsupported) assert.throws(() => inspectFixture(source))
})
