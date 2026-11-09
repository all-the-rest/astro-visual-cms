import test from 'node:test'
import assert from 'node:assert/strict'
import { createAstroGalleryAdapter } from '../src/lib/astro-gallery-patch.mjs'

const source = `---\nconst imageNames = [\n  { name: "one", alt: "First", image: ImageOne },\n  { name: "two", alt: "Second", image: ImageTwo },\n]\n---\n{imageNames.map((image) => <img alt={image.alt} />)}`
const adapter = createAstroGalleryAdapter({ variableName: 'imageNames' })
test('Astro internal gallery reorders literal objects and preserves all other bytes', () => {
  const state = adapter.inspect(source), result = adapter.patch(source, ['two', 'one'], state.hash)
  assert.deepEqual(adapter.inspect(result.source).order, ['two', 'one'])
  assert.equal(result.source.slice(0, result.diff.start), source.slice(0, result.diff.start))
  assert.equal(result.source.replace(result.diff.after, ''), source.replace(result.diff.before, ''))
})
test('dynamic, duplicate, commented, and ambiguous arrays fail closed', () => {
  for (const bad of [source.replace('"one"', 'identity'), source.replace('{ name: "two"', '{ name: "one"'), source.replace('const imageNames', '// comment\nconst imageNames'), source.replace('const imageNames = [', 'let imageNames = [')]) assert.throws(() => adapter.inspect(bad))
  const tooMany = `---\nconst imageNames = [${Array.from({ length: 101 }, (_, i) => `{ name: "${i}", alt: "Image ${i}" }`).join(',')}]\n---\n`
  assert.throws(() => adapter.inspect(tooMany), /limited to 100 entries/)
})
test('typed declarations and CRLF frontmatter map exact source offsets and retain separator slots', () => {
  const crlf = '---\r\ntype Item = { name: string; alt: string };\r\nconst imageNames: Item[] = [\r\n    { name: "one", alt: "First" },\r\n\t{ name: "two", alt: "Second" },\r\n]\r\n---\r\nrest\r\n'
  const typed = createAstroGalleryAdapter({ variableName: 'imageNames' })
  const state = typed.inspect(crlf), result = typed.patch(crlf, ['two', 'one'], state.hash)
  assert.equal(result.source, crlf.replace('{ name: "one", alt: "First" },\r\n\t{ name: "two", alt: "Second" },', '{ name: "two", alt: "Second" },\r\n\t{ name: "one", alt: "First" },'))
  assert.equal(result.diff.before, '[\r\n    { name: "one", alt: "First" },\r\n\t{ name: "two", alt: "Second" },\r\n]')
})
